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
/** git's mode for a symbolic link: its blob is the path it points to. */
const LINK_MODE = '120000';

interface TreeEntry {
  mode: string;
  /** blob (file or link), tree (folder) or commit (embedded repository). */
  type: string;
  object: string;
}

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
   * A file's content in a snapshot as the working tree had it (git's filters applied: line
   * endings, Git LFS), or null when the snapshot has no such file; undefined when that cannot be
   * said (binary, a link, git failed). Unlike fileAt, a failure is never "no file".
   */
  async contentAt(snapshot: string, relPath: string): Promise<string | null | undefined> {
    const entries = await this.entries(snapshot, [relPath]);
    if (!entries) return undefined;
    const entry = entries.get(relPath);
    if (!entry || entry.type === 'tree') return null;
    return entry.type === 'blob' && entry.mode !== LINK_MODE ? this.workingContent(snapshot, relPath) : undefined;
  }

  /**
   * A file's original for the change tracker, before it is written: its content at the snapshot,
   * or null when it did not exist then. Undefined means the file on disk is the original: it is
   * unchanged since (its exact bytes), a link (git keeps only where it points), or only the disk
   * can say (ignored, inside an embedded repository, binary, git failed). A file the snapshot
   * lacks counts as new only when the next snapshot would take it as one.
   */
  async originalAt(snapshot: string, relPath: string): Promise<string | null | undefined> {
    const parts = relPath.split('/');
    const ignoreFiles = parts.map((_, i) => [...parts.slice(0, i), '.gitignore'].join('/'));
    const entries = await this.entries(snapshot, [relPath, ...ignoreFiles]);
    if (!entries) return undefined;
    // Inside an embedded repository (a gitlink): the snapshots do not look in there.
    if ([...entries].some(([p, e]) => e.type === 'commit' && relPath.startsWith(`${p}/`))) return undefined;
    const entry = entries.get(relPath);
    if (entry && entry.type !== 'tree') {
      if (entry.type !== 'blob' || entry.mode === LINK_MODE) return undefined;
      const [now] = (await this.hashes([relPath])) ?? [];
      return now === entry.object ? undefined : this.workingContent(snapshot, relPath);
    }
    // A file ignored at the snapshot would pass for a new one once an ignore rule on its way is
    // gone, so those ignore files must be as they were (a missing one fails hash-object).
    const kept = ignoreFiles.filter((f) => entries.has(f));
    const hashes = kept.length ? await this.hashes(kept) : [];
    if (!hashes || kept.some((f, i) => entries.get(f)!.object !== hashes[i])) return undefined;
    const others = await this.git(['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', relPath]).catch(() => undefined);
    return others?.split('\0').includes(relPath) ? null : undefined;
  }

  /** Tree entries of a snapshot at these paths (taken literally); undefined when git failed. */
  private async entries(snapshot: string, paths: string[]): Promise<Map<string, TreeEntry> | undefined> {
    const out = await this.git(['--literal-pathspecs', 'ls-tree', '-z', snapshot, '--', ...paths]).catch(() => undefined);
    if (out === undefined) return undefined;
    const entries = new Map<string, TreeEntry>();
    for (const record of out.split('\0')) {
      const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(record);
      if (match) entries.set(match[4], { mode: match[1], type: match[2], object: match[3] });
    }
    return entries;
  }

  /** Blob ids the files on disk would get in a snapshot (clean filters applied); undefined when git failed. */
  private async hashes(relPaths: string[]): Promise<string[] | undefined> {
    const out = await this.git(['hash-object', '--', ...relPaths]).catch(() => undefined);
    return out?.trim().split(/\r?\n/);
  }

  /**
   * A file of a snapshot as a checkout would write it (line endings, smudge filters). Git LFS
   * never downloads here: the object the snapshot took is read from the snapshots' own store.
   */
  private async workingContent(snapshot: string, relPath: string): Promise<string | undefined> {
    const noDownload = { workTree: this.root, env: { GIT_LFS_SKIP_SMUDGE: '1' } };
    const filtered = await this.gitBuffer(['cat-file', '--filters', `${snapshot}:${relPath}`], 30_000, noDownload).catch(() => undefined);
    const pointer = filtered && lfsPointer(filtered);
    const data = pointer ? await this.lfsObject(pointer) : filtered;
    if (!data || data.subarray(0, 8000).includes(0)) return undefined;
    return data.toString('utf8');
  }

  private async lfsObject(pointer: { oid: string; size: number }): Promise<Buffer | undefined> {
    const file = path.join(this.gitDir, 'lfs', 'objects', pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
    const data = await fs.readFile(file).catch(() => undefined);
    return data?.length === pointer.size ? data : undefined;
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

/** The object a Git LFS pointer file stands for. */
function lfsPointer(data: Buffer): { oid: string; size: number } | undefined {
  if (data.length > 1024) return undefined;
  const text = data.toString('utf8');
  if (!text.startsWith('version https://git-lfs.github.com/spec/v1')) return undefined;
  const oid = /^oid sha256:([0-9a-f]{64})\r?$/m.exec(text)?.[1];
  const size = /^size (\d+)\r?$/m.exec(text)?.[1];
  return oid && size ? { oid, size: Number(size) } : undefined;
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
