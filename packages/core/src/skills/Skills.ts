import { t } from '../i18n';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { type Tool, ToolError, truncateMiddle } from '../tools/Tool';

/**
 * Skills are expert playbooks (Markdown with a small front matter) that the agent loads when a
 * task matches, e.g. "unity" or "debugging". They are global - built into the orchestrator or
 * kept in the user's own folder - not per project, so every project gets the same know-how.
 *
 * Accepted layouts in a skills folder:
 *   <name>.md                  single-file skill
 *   <name>/SKILL.md            skill folder; other files in it can be read with load_skill(file)
 *
 * Front matter:
 *   ---
 *   name: unity
 *   description: When to use this skill, in one or two sentences.
 *   ---
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
  source: 'builtin' | 'user';
  /** The skill's Markdown file. */
  path: string;
  /** Folder of a folder-style skill (supporting files live here). */
  dir?: string;
}

export interface SkillSource {
  dir: string;
  source: Skill['source'];
}

export interface LoadedSkills {
  skills: Skill[];
  /** Files that could not be used, with the reason. */
  errors: string[];
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_TOOL = 'load_skill';
const MAX_SKILL_CHARS = 60_000;
const MAX_SUPPORT_FILE_CHARS = 40_000;

/** Load skills from folders in order; a later folder overrides an earlier one by name. */
export async function loadSkills(sources: readonly SkillSource[]): Promise<LoadedSkills> {
  const byName = new Map<string, Skill>();
  const errors: string[] = [];
  for (const { dir, source } of sources) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // a missing folder simply has no skills
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const isFile = entry.isFile() && /\.md$/i.test(entry.name) && !/^readme\.md$/i.test(entry.name);
      const file = isFile ? path.join(dir, entry.name) : entry.isDirectory() ? path.join(dir, entry.name, 'SKILL.md') : undefined;
      if (!file) continue;
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        if (isFile) errors.push(`${file}: unreadable`);
        continue;
      }
      const fallbackName = isFile ? entry.name.replace(/\.md$/i, '') : entry.name;
      const parsed = parseSkill(text, fallbackName.toLowerCase());
      if ('error' in parsed) {
        errors.push(`${file}: ${parsed.error}`);
        continue;
      }
      byName.set(parsed.name, { ...parsed, source, path: file, dir: isFile ? undefined : path.dirname(file) });
    }
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

export function parseSkill(text: string, fallbackName: string): { name: string; description: string; body: string } | { error: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  const meta: Record<string, string> = {};
  if (match) {
    for (const line of match[1].split('\n')) {
      const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  const body = (match ? match[2] : normalized).trim();
  const name = (meta.name || fallbackName).trim().toLowerCase();
  if (!SKILL_NAME.test(name)) return { error: `invalid skill name "${name}" (use lowercase letters, digits and dashes)` };
  if (!meta.description) return { error: 'missing "description" in the front matter' };
  if (!body) return { error: 'the skill has no content' };
  return { name, description: meta.description, body: truncateMiddle(body, MAX_SKILL_CHARS) };
}

/** System prompt section listing the skills of a task. */
export function skillsPrompt(skills: readonly Skill[]): string {
  if (!skills.length) return '';
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  return `# Skills
Skills are expert playbooks for particular kinds of work. When the task (or part of it) matches a skill below, call ${SKILL_TOOL} with its name before you start that part, then follow it - it overrides your general habits where they differ, but never the user's instructions. Load only the skills that apply; one or two is typical.
${list}`;
}

/** The load_skill tool for a fixed set of skills. */
export function createSkillTool(skills: readonly Skill[]): Tool<{ name: string; file?: string }> {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    name: SKILL_TOOL,
    description:
      'Load a skill: an expert playbook for a kind of task (see the Skills section of your instructions). ' +
      'Returns its full instructions. For a skill that references supporting files, pass file to read one of them.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: skills.map((s) => s.name), description: 'The skill to load.' },
        file: { type: 'string', description: "Optional: a supporting file inside the skill's folder, e.g. \"reference.md\"." },
      },
      required: ['name'],
    },
    describe: (input) => ({ category: 'read', risk: 'safe', title: t('Skill: {name}', { name: input.file ? `${input.name}/${input.file}` : input.name }) }),
    async execute(input) {
      const skill = byName.get(input.name);
      if (!skill) throw new ToolError(`Unknown skill "${input.name}". Available: ${[...byName.keys()].join(', ') || 'none'}.`);
      if (!input.file) return { content: `<skill name="${skill.name}">\n${skill.body}\n</skill>` };
      if (!skill.dir) throw new ToolError(`The "${skill.name}" skill has no supporting files.`);
      const target = path.resolve(skill.dir, input.file);
      const inside = path.relative(skill.dir, target);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new ToolError('file must be inside the skill folder.');
      try {
        return { content: truncateMiddle(await fs.readFile(target, 'utf8'), MAX_SUPPORT_FILE_CHARS) };
      } catch {
        throw new ToolError(`No file "${input.file}" in the "${skill.name}" skill.`);
      }
    },
  };
}

/** A skill the user invoked explicitly (e.g. "/unity ..."), attached to their message. */
export function invokedSkillBlock(skill: Skill): string {
  return `<skill name="${skill.name}" invoked_by="user">\nThe user asked you to follow this skill for this request.\n\n${skill.body}\n</skill>`;
}

/** Front matter + outline for a new user skill. */
export function skillTemplate(name: string): string {
  return `---
name: ${name}
description: One or two sentences on WHEN the agent should use this skill (the agent decides from this line).
---

# ${name}

## When this applies
- ...

## How to work
1. ...

## Checks before finishing
- ...
`;
}
