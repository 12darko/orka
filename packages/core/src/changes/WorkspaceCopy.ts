import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Host } from '../host/Host';
import type { ChangeTracker } from './ChangeTracker';
import { unifiedDiff } from './diff';
import { type CommandChange, mergeText, type ShadowGit } from './ShadowGit';

/**
 * A private copy of the workspace as it was in a snapshot, for a worker that runs side by side
 * with others. Ignored folders (node_modules, Library, obj, ...) and files the project's
 * .gitignore leaves out are not part of it, and it has no .git: it is for editing, not building.
 */
export class WorkspaceCopy {
  private constructor(
    readonly dir: string,
    private readonly index: string,
    private readonly shadow: ShadowGit,
    readonly base: string,
  ) {}

  static async create(shadow: ShadowGit, base: string): Promise<WorkspaceCopy> {
    const parent = await fs.mkdtemp(path.join(tmpdir(), 'orka-worker-'));
    const dir = path.join(parent, 'workspace');
    await fs.mkdir(dir);
    const copy = new WorkspaceCopy(dir, path.join(parent, 'index'), shadow, base);
    try {
      await shadow.exportTo(base, dir, copy.index);
    } catch (error) {
      await copy.dispose();
      throw error;
    }
    return copy;
  }

  /** What the worker changed in its copy. */
  changes(): Promise<CommandChange[]> {
    return this.shadow.changedIn(this.dir, this.index, this.base);
  }

  /** A file of the copy as text; null when missing, undefined when binary. */
  async read(relPath: string): Promise<string | null | undefined> {
    const data = await fs.readFile(path.join(this.dir, relPath)).catch(() => null);
    if (data === null) return null;
    if (data.subarray(0, 8000).includes(0)) return undefined;
    return data.toString('utf8');
  }

  async dispose(): Promise<void> {
    await fs.rm(path.dirname(this.dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}

export interface MergeOutcome {
  /** Workspace-relative paths written into the workspace (" (merged)" when combined with other changes). */
  applied: string[];
  /** Files changed both here and in the workspace in overlapping ways: left as they are in the workspace. */
  conflicts: Array<{ path: string; diff: string }>;
  /** Binary files: not merged. */
  skipped: string[];
}

/**
 * Bring a worker's changes from its copy into the workspace. A file nobody else changed since the
 * snapshot is taken over as is; one that changed in the workspace too (e.g. by an earlier worker)
 * is merged three-way when the changes do not overlap, and reported as a conflict when they do.
 * Every write goes through the change tracker, so it can be reviewed, reverted and rewound.
 */
export async function mergeCopy(copy: WorkspaceCopy, changes: readonly CommandChange[], host: Host, shadow: ShadowGit, tracker: ChangeTracker): Promise<MergeOutcome> {
  const outcome: MergeOutcome = { applied: [], conflicts: [], skipped: [] };
  for (const change of changes) {
    const abs = path.join(host.workspaceRoot, change.path);
    const base = change.status === 'added' ? null : await shadow.fileAt(copy.base, change.path);
    const theirs = change.status === 'deleted' ? null : await copy.read(change.path);
    if (base === undefined || theirs === undefined) {
      outcome.skipped.push(change.path);
      continue;
    }
    const current = (await host.exists(abs)) ? await host.readFile(abs) : null;
    if (current === theirs) continue;
    let next: string | null | undefined;
    let label = change.path;
    if (current === base) next = theirs;
    else if (current !== null && base !== null && theirs !== null) {
      const merged = await mergeText(current, base, theirs);
      if (merged.clean) {
        next = merged.text;
        label = `${change.path} (merged)`;
      }
    }
    if (next === undefined) {
      outcome.conflicts.push({ path: change.path, diff: unifiedDiff(change.path, base, theirs) });
      continue;
    }
    await tracker.recordBefore(abs);
    if (next === null) await host.deleteFile(abs);
    else await host.writeFile(abs, next);
    outcome.applied.push(label);
  }
  if (outcome.applied.length) tracker.notify();
  return outcome;
}
