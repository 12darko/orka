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

function rank(order: string[], name: string): number {
  const i = order.indexOf(name);
  return i === -1 ? order.length : i;
}

function isUntouchedTemplate(name: string, text: string): boolean {
  return TEMPLATES[name] !== undefined && TEMPLATES[name].trim() === text;
}
