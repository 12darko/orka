import * as path from 'node:path';
import type { Host } from '../host/Host';

export const MEMORY_DIR = '.project-ai';
const MAX_MEMORY_CHARS = 24_000;

const TEMPLATES: Record<string, string> = {
  'project-context.md': '# Project Context\n\nWhat this project is, who it is for, and its current state.\n',
  'architecture.md': '# Architecture\n\nMain modules, how they talk to each other, key technologies.\n',
  'decisions.md': '# Decisions\n\nDurable decisions (framework choices, patterns). Newest last.\n\n<!-- Example:\n## Networking: Photon Fusion 2\nWhy: ...\n-->\n',
  'conventions.md': '# Conventions\n\nNaming, folder layout, code style, testing rules.\n',
};

/**
 * Per-project memory in `.project-ai/`. Loaded into the system prompt at the start of each task
 * so the agent does not rediscover past architectural decisions every conversation.
 */
export async function loadProjectMemory(host: Host): Promise<string | undefined> {
  const dir = path.join(host.workspaceRoot, MEMORY_DIR);
  if (!(await host.isDirectory(dir))) return undefined;
  const entries = (await host.listDir(dir)).filter((e) => !e.isDirectory && e.name.toLowerCase().endsWith('.md'));
  const order = Object.keys(TEMPLATES);
  entries.sort((a, b) => rank(order, a.name) - rank(order, b.name) || a.name.localeCompare(b.name));
  const parts: string[] = [];
  let total = 0;
  for (const entry of entries) {
    const text = (await host.readFile(path.join(dir, entry.name))).trim();
    if (!text || isUntouchedTemplate(entry.name, text)) continue;
    const block = `## ${MEMORY_DIR}/${entry.name}\n${text}`;
    if (total + block.length > MAX_MEMORY_CHARS) {
      parts.push(`## ${MEMORY_DIR}/${entry.name}\n(omitted - memory too large; read the file if needed)`);
      continue;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

/** Create the `.project-ai/` skeleton. Existing files are left untouched. Returns created paths. */
export async function initProjectMemory(host: Host): Promise<string[]> {
  const created: string[] = [];
  for (const [name, content] of Object.entries(TEMPLATES)) {
    const file = path.join(host.workspaceRoot, MEMORY_DIR, name);
    if (await host.exists(file)) continue;
    await host.writeFile(file, content);
    created.push(`${MEMORY_DIR}/${name}`);
  }
  return created;
}

export const LESSONS_FILE = 'lessons.md';
const LESSONS_HEADER =
  '# Lessons\n\nLearned by Orka while working on this project: build and test commands that work, pitfalls, conventions.\n' +
  'Edit or delete lines freely; every new task starts by reading this file.\n';
const MAX_LESSONS = 60;
const MAX_LESSON_CHARS = 300;

/** Lesson lines ("- ...") from a model's reply; "NONE" or anything else yields nothing. */
export function parseLessons(reply: string, max = 3): string[] {
  return reply
    .split(/\r?\n/)
    .map((line) => /^\s*[-*]\s+(.+)$/.exec(line)?.[1].trim())
    .filter((line): line is string => !!line && line.length >= 12)
    .map((line) => (line.length > MAX_LESSON_CHARS ? `${line.slice(0, MAX_LESSON_CHARS - 1)}…` : line))
    .slice(0, max);
}

/**
 * Append new lessons to `.project-ai/lessons.md` (only when the project has a memory folder),
 * skipping ones already there and keeping the newest MAX_LESSONS. Returns the lessons added and the
 * file's path, or undefined when nothing was written.
 */
export async function appendLessons(host: Host, lessons: readonly string[], beforeWrite?: (absPath: string) => Promise<void>): Promise<{ added: string[]; file: string } | undefined> {
  const dir = path.join(host.workspaceRoot, MEMORY_DIR);
  if (!lessons.length || !(await host.isDirectory(dir))) return undefined;
  const file = path.join(dir, LESSONS_FILE);
  const existing = (await host.exists(file)) ? await host.readFile(file) : LESSONS_HEADER;
  const lines = existing.split(/\r?\n/);
  const known = new Set(lines.map((l) => /^\s*-\s+(.+)$/.exec(l)?.[1]).filter((l): l is string => !!l).map(normalizeLesson));
  const added = lessons.filter((lesson) => {
    const key = normalizeLesson(lesson);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (!added.length) return undefined;
  const body = [...lines.filter((l) => !/^\s*-\s+/.test(l)).join('\n').trimEnd().split('\n'), ''];
  const bullets = [...lines.filter((l) => /^\s*-\s+/.test(l)), ...added.map((l) => `- ${l}`)].slice(-MAX_LESSONS);
  await beforeWrite?.(file);
  await host.writeFile(file, `${[...body, ...bullets].join('\n')}\n`);
  return { added, file };
}

function normalizeLesson(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function rank(order: string[], name: string): number {
  const i = order.indexOf(name);
  return i === -1 ? order.length : i;
}

function isUntouchedTemplate(name: string, text: string): boolean {
  return TEMPLATES[name] !== undefined && TEMPLATES[name].trim() === text;
}
