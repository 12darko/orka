import * as path from 'node:path';
import type { Host } from '../host/Host';
import { acceptHunkIn, type DiffHunk, hunksBetween, lineStats, revertHunkIn, unifiedDiff } from './diff';

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface FileChange {
  absPath: string;
  relPath: string;
  status: ChangeStatus;
  /** Line counts from a line diff. */
  added: number;
  removed: number;
}

/** A file's content before the agent first touched it, as stored with a task (checkpoint). */
export interface ChangeCheckpoint {
  /** Workspace-relative path with forward slashes. */
  path: string;
  /** null: the file did not exist. */
  original: string | null;
}

/** Originals larger than this are not stored with a task (the file can still be reverted until then). */
const MAX_CHECKPOINT_FILE = 1_000_000;
const MAX_CHECKPOINT_TOTAL = 8_000_000;

/**
 * Snapshots each file the first time the agent touches it, so every AI change can be shown as
 * a diff, accepted (snapshot dropped) or reverted (snapshot restored) - individually or all.
 */
export class ChangeTracker {
  /** absPath -> content before the agent first touched it (null = file did not exist). */
  private originals = new Map<string, string | null>();
  /**
   * Rewind points: each epoch (one per user request) keeps the content of every file as it was
   * when that epoch began, captured the first time the file changes during it.
   */
  private epochs: Array<Map<string, string | null>> = [];
  private listeners = new Set<() => void>();

  constructor(private readonly host: Host) {}

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Call before modifying/deleting a file. Only the first snapshot per file (and per epoch) is kept. */
  async recordBefore(absPath: string): Promise<void> {
    const key = normalize(absPath);
    const epoch = this.epochs.at(-1);
    const forTask = !this.originals.has(key);
    const forEpoch = !!epoch && !epoch.has(key);
    if (!forTask && !forEpoch) return;
    const content = (await this.host.exists(absPath)) ? await this.host.readFile(absPath) : null;
    if (forTask) this.originals.set(key, content);
    if (forEpoch) epoch!.set(key, content);
  }

  /** Record a known original (e.g. from a snapshot taken before a command); only the first one counts. */
  recordOriginal(absPath: string, original: string | null): void {
    const key = normalize(absPath);
    if (!this.originals.has(key)) this.originals.set(key, original);
    const epoch = this.epochs.at(-1);
    if (epoch && !epoch.has(key)) epoch.set(key, original);
  }

  /** Start a rewind point here; returns its number for rewindTo. */
  startEpoch(): number {
    this.epochs.push(new Map());
    return this.epochs.length - 1;
  }

  /** Forget all rewind points (files stay as they are). */
  clearEpochs(): void {
    this.epochs = [];
  }

  /**
   * Put every file changed since rewind point `epoch` back the way it was then, and drop that
   * point and the later ones. A restored file the tracker no longer followed (its change was kept)
   * is followed again from its current content, so the rewind itself shows up as a reviewable change.
   */
  async rewindTo(epoch: number): Promise<string[]> {
    if (epoch < 0 || epoch >= this.epochs.length) return [];
    const target = new Map<string, string | null>();
    // The earliest capture wins: it is the content when the rewind point began.
    for (const map of this.epochs.slice(epoch)) for (const [key, content] of map) if (!target.has(key)) target.set(key, content);
    this.epochs = this.epochs.slice(0, epoch);
    const restored: string[] = [];
    for (const [key, content] of target) {
      const current = await this.current(key);
      if (current === content) continue;
      if (!this.originals.has(key)) this.originals.set(key, current);
      if (content === null) await this.host.deleteFile(key);
      else await this.host.writeFile(key, content);
      // Earlier rewind points still hold their own older captures of this file.
      restored.push(this.relative(key));
    }
    this.notify();
    return restored.sort();
  }

  /** Call after modifying a file to notify listeners. */
  notify(): void {
    for (const listener of this.listeners) listener();
  }

  getOriginal(absPath: string): string | null | undefined {
    return this.originals.get(normalize(absPath));
  }

  isTracked(absPath: string): boolean {
    return this.originals.has(normalize(absPath));
  }

  /** Current net changes; files edited back to their original content are omitted. */
  async list(): Promise<FileChange[]> {
    const changes: FileChange[] = [];
    for (const [absPath, original] of this.originals) {
      const exists = await this.host.exists(absPath);
      const current = exists ? await this.host.readFile(absPath) : null;
      let status: ChangeStatus | undefined;
      if (original === null) status = exists ? 'added' : undefined;
      else if (!exists) status = 'deleted';
      else if (current !== original) status = 'modified';
      if (status) changes.push({ absPath, relPath: this.relative(absPath), status, ...lineStats(original, current) });
    }
    return changes.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  /** Keep the change: forget the snapshot. */
  accept(absPath: string): void {
    this.originals.delete(normalize(absPath));
    this.notify();
  }

  acceptAll(): void {
    this.originals.clear();
    this.notify();
  }

  /** Restore the file to its state before the agent touched it. */
  async revert(absPath: string): Promise<void> {
    const key = normalize(absPath);
    if (!this.originals.has(key)) return;
    const original = this.originals.get(key)!;
    if (original === null) await this.host.deleteFile(key);
    else await this.host.writeFile(key, original);
    this.originals.delete(key);
    this.notify();
  }

  async revertAll(): Promise<string[]> {
    const reverted: string[] = [];
    for (const absPath of [...this.originals.keys()]) {
      await this.revert(absPath);
      reverted.push(this.relative(absPath));
    }
    return reverted;
  }

  /** Hunks of a tracked file's net change (empty when unchanged or untracked). */
  async hunks(absPath: string): Promise<DiffHunk[]> {
    const key = normalize(absPath);
    if (!this.originals.has(key)) return [];
    return hunksBetween(this.originals.get(key)!, await this.current(key));
  }

  /**
   * Undo one hunk of a modified file, leaving the rest of the AI's change in place. Added and
   * deleted files are reverted as a whole instead. Returns false if the hunk no longer exists.
   */
  async revertHunk(absPath: string, index: number): Promise<boolean> {
    const key = normalize(absPath);
    const original = this.originals.get(key);
    const current = await this.current(key);
    if (original === undefined || original === null || current === null) return false;
    const hunk = hunksBetween(original, current)[index];
    if (!hunk) return false;
    const next = revertHunkIn(current, hunk);
    await this.host.writeFile(key, next);
    if (next === original) this.originals.delete(key);
    this.notify();
    return true;
  }

  /**
   * Keep one hunk of a modified file (the rest stays reviewable): its new lines become part of the
   * snapshot. Returns false if the hunk no longer exists.
   */
  async acceptHunk(absPath: string, index: number): Promise<boolean> {
    const key = normalize(absPath);
    const original = this.originals.get(key);
    const current = await this.current(key);
    if (original === undefined || original === null || current === null) return false;
    const hunk = hunksBetween(original, current)[index];
    if (!hunk) return false;
    const next = acceptHunkIn(original, hunk);
    if (next === current) this.originals.delete(key);
    else this.originals.set(key, next);
    this.notify();
    return true;
  }

  /** Unified diff of every net change, for reviewers; long output is cut at `maxChars`. */
  async unifiedDiffs(maxChars = 20_000): Promise<string> {
    const parts: string[] = [];
    let size = 0;
    for (const change of await this.list()) {
      const diff = unifiedDiff(change.relPath, this.originals.get(normalize(change.absPath)) ?? null, await this.current(change.absPath));
      if (size + diff.length > maxChars) {
        parts.push(`... diff of ${change.relPath} and later files omitted (${change.status}, +${change.added} -${change.removed})`);
        break;
      }
      parts.push(diff);
      size += diff.length;
    }
    return parts.join('\n');
  }

  /** Originals of all tracked files, to store with a task so it can be reverted after reopening. */
  exportCheckpoint(): ChangeCheckpoint[] {
    const out: ChangeCheckpoint[] = [];
    let total = 0;
    for (const [absPath, original] of this.originals) {
      const size = original?.length ?? 0;
      if (size > MAX_CHECKPOINT_FILE || total + size > MAX_CHECKPOINT_TOTAL) continue;
      total += size;
      out.push({ path: this.relative(absPath), original });
    }
    return out;
  }

  /** Replace the tracked originals with a stored checkpoint (paths outside the workspace are ignored). */
  importCheckpoint(entries: readonly ChangeCheckpoint[]): void {
    this.originals.clear();
    this.epochs = [];
    const root = path.resolve(this.host.workspaceRoot);
    for (const entry of entries) {
      if (typeof entry?.path !== 'string' || (entry.original !== null && typeof entry.original !== 'string')) continue;
      const abs = path.resolve(root, entry.path);
      const inside = path.relative(root, abs);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue;
      this.originals.set(normalize(abs), entry.original);
    }
    this.notify();
  }

  /** Forget every snapshot without touching files (a new task starts with a clean change list). */
  clear(): void {
    this.epochs = [];
    if (!this.originals.size) return;
    this.originals.clear();
    this.notify();
  }

  private async current(absPath: string): Promise<string | null> {
    return (await this.host.exists(absPath)) ? this.host.readFile(absPath) : null;
  }

  private relative(absPath: string): string {
    return path.relative(this.host.workspaceRoot, absPath).split(path.sep).join('/');
  }
}


function normalize(absPath: string): string {
  const resolved = path.resolve(absPath);
  return process.platform === 'win32' ? resolved.replace(/^[a-z]:/, (d) => d.toUpperCase()) : resolved;
}
