import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { IGNORED_DIRS } from '../tools/workspace';

export interface CommandChange {
  /** Workspace-relative path with forward slashes. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

const SNAPSHOT_TIMEOUT_MS = 60_000;

/**
 * Snapshots of the workspace in a private git repository (its own git dir, the workspace as work
 * tree), so files changed by terminal commands - npm install, code generators, formatters - can be
 * shown and reverted like the agent's own edits. The user's own repository is never touched;
 * ignored folders (node_modules, Library, obj, ...) and the project's .gitignore are respected.
 */
export class ShadowGit {
  private initialized?: Promise<void>;
  /** Why snapshots are off (no git, workspace too large); undefined while they work. */
  disabledReason?: string;

  constructor(
    private readonly root: string,
    private readonly gitDir: string,
  ) {}

  get enabled(): boolean {
    return !this.disabledReason;
  }

  /** Record the current state of the workspace; returns the snapshot id, or undefined if snapshots are off. */
  async snapshot(): Promise<string | undefined> {
    if (this.disabledReason) return undefined;
    try {
      await this.init();
      await this.git(['add', '-A'], SNAPSHOT_TIMEOUT_MS);
      await this.git(['commit', '-q', '--allow-empty', '--no-verify', '-m', 'orka snapshot'], SNAPSHOT_TIMEOUT_MS);
      return (await this.git(['rev-parse', 'HEAD'])).trim();
    } catch (error) {
      this.disabledReason = /timed out|ETIMEDOUT|killed/i.test(String(error))
        ? 'the workspace is too large to snapshot quickly'
        : `git is not available (${String(error instanceof Error ? error.message : error).split('\n')[0]})`;
      return undefined;
    }
  }

  /** Files that differ between a snapshot and the workspace now. */
  async changedSince(snapshot: string): Promise<CommandChange[]> {
    await this.git(['add', '-A'], SNAPSHOT_TIMEOUT_MS);
    const out = await this.git(['diff', '--cached', '--name-status', '--no-renames', snapshot]);
    return parseNameStatus(out);
  }

  /** A file's content in a snapshot; undefined for binary files (they are not revertible as text). */
  async fileAt(snapshot: string, relPath: string): Promise<string | null | undefined> {
    const data = await this.gitBuffer(['show', `${snapshot}:${relPath}`]).catch(() => null);
    if (data === null) return null;
    if (data.subarray(0, 8000).includes(0)) return undefined;
    return data.toString('utf8');
  }

  /**
   * A file's content in a snapshot, or null when the snapshot has no such file; undefined when
   * that cannot be said (binary, or git failed). Unlike fileAt, a failure is never "no file".
   */
  async contentAt(snapshot: string, relPath: string): Promise<string | null | undefined> {
    // ls-tree takes paths literally (no wildcards).
    const listed = await this.git(['ls-tree', '-z', '--name-only', snapshot, '--', relPath]).catch(() => undefined);
    if (listed === undefined) return undefined;
    if (!listed) return null;
    const data = await this.gitBuffer(['show', `${snapshot}:${relPath}`]).catch(() => undefined);
    if (!data || data.subarray(0, 8000).includes(0)) return undefined;
    return data.toString('utf8');
  }

  /**
   * Write a snapshot's files into the empty folder `dir`. `index` is a git index file of the
   * copy's own, so the workspace's snapshots are not disturbed.
   */
  async exportTo(snapshot: string, dir: string, index: string): Promise<void> {
    await this.init();
    const copy = { workTree: dir, env: { GIT_INDEX_FILE: index } };
    await this.gitBuffer(['read-tree', snapshot], SNAPSHOT_TIMEOUT_MS, copy);
    await this.gitBuffer(['checkout-index', '-a', '-f'], SNAPSHOT_TIMEOUT_MS, copy);
  }

  /** Files that differ between a snapshot and a copy made with exportTo. */
  async changedIn(dir: string, index: string, snapshot: string): Promise<CommandChange[]> {
    const copy = { workTree: dir, env: { GIT_INDEX_FILE: index } };
    await this.gitBuffer(['add', '-A'], SNAPSHOT_TIMEOUT_MS, copy);
    const out = (await this.gitBuffer(['diff', '--cached', '--name-status', '--no-renames', snapshot], 30_000, copy)).toString('utf8');
    return parseNameStatus(out);
  }

  private init(): Promise<void> {
    this.initialized ??= (async () => {
      await fs.mkdir(this.gitDir, { recursive: true });
      if (!existsSync(path.join(this.gitDir, 'HEAD'))) await this.git(['init', '-q']);
      const excludes = [...IGNORED_DIRS].map((d) => `${d}/`).join('\n');
      await fs.mkdir(path.join(this.gitDir, 'info'), { recursive: true });
      await fs.writeFile(path.join(this.gitDir, 'info', 'exclude'), `${excludes}\n`, 'utf8');
    })();
    return this.initialized;
  }

  private git(args: string[], timeout = 30_000): Promise<string> {
    return this.gitBuffer(args, timeout).then((b) => b.toString('utf8'));
  }

  private gitBuffer(args: string[], timeout = 30_000, copy?: { workTree: string; env: Record<string, string> }): Promise<Buffer> {
    const workTree = copy?.workTree ?? this.root;
    const full = [
      `--git-dir=${this.gitDir}`,
      `--work-tree=${workTree}`,
      '-c', 'core.autocrlf=false',
      '-c', 'core.quotepath=false',
      '-c', 'core.safecrlf=false',
      '-c', 'user.name=Orka',
      '-c', 'user.email=orka@localhost',
      '-c', 'commit.gpgsign=false',
      ...args,
    ];
    const env = copy ? { ...process.env, ...copy.env } : process.env;
    return new Promise((resolve, reject) =>
      execFile('git', full, { cwd: workTree, env, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (error, stdout, stderr) =>
        error ? reject(new Error(`${error.message}\n${stderr.toString('utf8')}`)) : resolve(stdout),
      ),
    );
  }
}

function parseNameStatus(out: string): CommandChange[] {
  const changes: CommandChange[] = [];
  for (const line of out.split('\n')) {
    const m = /^([AMD])\t(.+)$/.exec(line.trim());
    if (m) changes.push({ path: m[2], status: m[1] === 'A' ? 'added' : m[1] === 'D' ? 'deleted' : 'modified' });
  }
  return changes;
}

/**
 * Three-way merge of a text file that two sides changed from `base` (git merge-file). `clean` is
 * false when the changes overlap.
 */
export async function mergeText(current: string, base: string, theirs: string): Promise<{ clean: boolean; text: string }> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'orka-merge-'));
  try {
    const files = ['current', 'base', 'theirs'].map((name) => path.join(dir, name));
    await Promise.all([current, base, theirs].map((text, i) => fs.writeFile(files[i], text, 'utf8')));
    return await new Promise((resolve) =>
      execFile('git', ['merge-file', '-p', ...files], { cwd: dir, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) =>
        // The exit code is the number of conflicts (negative on errors).
        resolve({ clean: !error, text: stdout }),
      ),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
