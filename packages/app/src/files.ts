import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Folders never worth searching for "@file" completions. */
const SKIP = new Set(['node_modules', '.git', 'Library', 'obj', 'bin', 'dist', 'out', 'build', 'Temp', '.vs', '.idea', '.next', 'coverage', '__pycache__', '.venv', 'venv']);
const MAX_ENTRIES = 50_000;

/**
 * Workspace-relative paths (forward slashes) of files whose name contains `query`, breadth-first
 * so shallow matches come first. For apps without an editor's file index (the desktop app).
 */
export async function findFilesByName(root: string, query: string, limit: number): Promise<string[]> {
  const needle = query.toLowerCase();
  const found: string[] = [];
  const queue = [''];
  let seen = 0;
  while (queue.length && found.length < limit && seen < MAX_ENTRIES) {
    const rel = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen++;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) queue.push(child);
      } else if (entry.isFile() && entry.name.toLowerCase().includes(needle)) {
        found.push(child);
        if (found.length >= limit) break;
      }
    }
  }
  return found;
}
