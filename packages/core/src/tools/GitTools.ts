import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { programPath } from '../host/commands';
import type { Tool, ToolAction } from './Tool';
import { ToolError, truncateMiddle } from './Tool';
import { resolveInWorkspace, toRelative } from './workspace';

const MAX_GIT_OUTPUT = 40_000;

/**
 * Git that Orka runs on its own (status for the context, the git tools) never starts programs a
 * repository's config names: no fsmonitor hook, no external diff or textconv drivers.
 */
export function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const [command, ...rest] = args;
  const noDrivers = command === 'diff' || command === 'log' || command === 'show' ? ['--no-ext-diff', '--no-textconv'] : [];
  // By its full path: started by name in the workspace, Windows would run a git.exe it ships.
  const git = programPath('git');
  if (!git) return Promise.reject(new ToolError('git is not installed (it was not found on PATH).'));
  return new Promise((resolve, reject) => {
    execFile(git, ['-c', 'core.fsmonitor=false', command, ...noDrivers, ...rest], { cwd, maxBuffer: 20_000_000, signal, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || error.message).trim();
        reject(new ToolError(/not a git repository/i.test(message) ? 'This workspace is not a git repository.' : message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Keys in a repository's own git config that make git start a program. Read-only commands start
 * some of them too: the fsmonitor hook, external diff and textconv drivers (diff, log -p, show,
 * blame), filters (status, diff), the pager, and gpg (log and show with --show-signature, or with
 * log.showSignature on).
 */
const RISKY_KEY = /^(core\.(fsmonitor|hookspath|sshcommand|pager)|pager\..+|diff\.external|diff\..+\.(textconv|command)|filter\..+\.(clean|smudge|process)|gpg\.(.+\.)?program|gpg\.ssh\.defaultkeycommand|include\.path|includeif\..+\.path)$/;
const BOOLEAN = /^(true|false|yes|no|on|off|0|1|)$/i;
/** Git LFS's own filter commands, exactly as `git lfs install` writes them. */
const LFS_FILTER = /^git[- ]lfs (clean|smudge|filter-process)( --skip)?( (-- )?%f)?$/i;
/** How deep submodules are followed; deeper ones count as a risk of their own. */
const MAX_SUBMODULE_DEPTH = 8;

/**
 * Settings in the config of the repository `dir` is in (a downloaded project can ship a .git/config
 * with an fsmonitor hook or a filter), and of its submodules, which git status and diff look into,
 * that make git start programs; also a post-index-change hook, which runs when status writes the
 * index. Git LFS filters and the built-in fsmonitor are fine. Returns the risky keys (with the
 * submodule they are in), empty when there are none.
 */
export async function gitConfigRisk(dir: string): Promise<string[]> {
  const risky = new Set<string>();
  for (const repo of await reposOf(dir)) await collectRisk(repo, '', risky, 0);
  return [...risky];
}

/**
 * Of those keys, the ones that still matter for Orka's own hardened git calls (which run no
 * fsmonitor, diff driver, pager or gpg): filters, which status and diff run, hooks, which run
 * when status writes the index, and includes.
 */
export function riskForHardenedGit(keys: readonly string[]): string[] {
  return keys.filter((k) => /^(filter\.|include|hooks\/|core\.hookspath|submodules )/.test(k));
}

interface Repo {
  /** Its worktree (index paths are relative to it). */
  top: string;
  gitDir: string;
  commonDir: string;
  /** Its config files, in the order git reads them. */
  configs: string[];
}

async function collectRisk(repo: Repo, where: string, risky: Set<string>, depth: number): Promise<void> {
  const label = (key: string) => (where ? `${key} (in ${where})` : key);
  let showSignature = false;
  let gpg = false;
  let hashLength = 20;
  for (const file of repo.configs) {
    for (const [name, value] of await configEntries(file)) {
      const key = name.toLowerCase();
      // A key without "=" is true.
      if (key === 'log.showsignature') showSignature = value === undefined || isTrue(value);
      if (key === 'extensions.objectformat') hashLength = value?.trim().toLowerCase() === 'sha256' ? 32 : 20;
      if (!RISKY_KEY.test(key)) continue;
      const text = (value ?? 'true').trim();
      if ((key === 'core.fsmonitor' || key.startsWith('pager.')) && BOOLEAN.test(text)) continue;
      if (key === 'core.pager' && /^(cat)?$/.test(text)) continue;
      if (key.startsWith('filter.') && LFS_FILTER.test(text)) continue;
      if (key.startsWith('gpg.')) gpg = true;
      risky.add(label(key));
    }
  }
  if (showSignature && gpg) risky.add(label('log.showsignature'));
  for (const hook of ['post-index-change', 'post-index-change.exe']) {
    if (await lexists(path.join(repo.commonDir, 'hooks', hook))) risky.add(label(`hooks/${hook}`));
  }
  for (const link of await gitlinks(repo, hashLength)) {
    const sub = await repoAt(path.join(repo.top, link));
    if (!sub) continue; // not checked out: git does not look into it
    const inner = where ? `${where}/${link}` : link;
    if (depth >= MAX_SUBMODULE_DEPTH) risky.add(`submodules nested deeper than ${MAX_SUBMODULE_DEPTH} (in ${inner})`);
    else await collectRisk(sub, inner, risky, depth + 1);
  }
}

/**
 * The keys and values of one config file, read the way git reads it (includes are not followed:
 * include.path counts as a risk of its own). Git does it when it is installed (reading config runs
 * no program); without git, or with a file git cannot read, it is read by hand.
 */
async function configEntries(file: string): Promise<Array<[string, string | undefined]>> {
  const text = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return [];
  try {
    // Started outside the repository: nothing in it is looked up.
    const out = await runGit(os.tmpdir(), ['config', '--file', file, '--no-includes', '--null', '--list']);
    // "key\nvalue" per entry, NUL-separated; a key without "=" has no newline.
    return out
      .split('\0')
      .filter(Boolean)
      .map((entry): [string, string | undefined] => {
        const newline = entry.indexOf('\n');
        return newline < 0 ? [entry, undefined] : [entry.slice(0, newline), entry.slice(newline + 1)];
      });
  } catch {
    return parseGitConfig(text);
  }
}

/**
 * A git config file read by hand, the way git reads it: keys may follow a section header on the
 * same line, values may be quoted and continued with a backslash, # and ; start comments outside
 * quotes, and [section.sub] is the old form of [section "sub"].
 */
export function parseGitConfig(text: string): Array<[string, string | undefined]> {
  const entries: Array<[string, string | undefined]> = [];
  const s = text.replace(/^\uFEFF/, '');
  let section = '';
  let i = 0;
  const skipLine = () => {
    while (i < s.length && s[i] !== '\n') i++;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
      i++;
    } else if (c === '#' || c === ';') {
      skipLine();
    } else if (c === '[') {
      // [name], [name "sub"] (the sub-section keeps its case; \ escapes) or [name.sub]
      const header = /^\[\s*([\w.-]+)\s*(?:"((?:[^"\\\n]|\\.)*)"\s*)?\]/.exec(s.slice(i, i + 4096));
      if (!header) {
        section = '';
        skipLine();
        continue;
      }
      section = header[2] !== undefined ? `${header[1].toLowerCase()}.${header[2].replace(/\\(.)/g, '$1')}` : header[1].toLowerCase();
      i += header[0].length;
    } else if (/[A-Za-z]/.test(c)) {
      let name = '';
      while (i < s.length && /[\w-]/.test(s[i])) name += s[i++];
      while (s[i] === ' ' || s[i] === '\t') i++;
      let value: string | undefined;
      if (s[i] === '=') {
        i++;
        value = '';
        let quoted = false;
        let pending = '';
        while (i < s.length) {
          const ch = s[i++];
          if (ch === '\n' && !quoted) break;
          if (ch === '\r' && s[i] === '\n') continue;
          if (!quoted && (ch === '#' || ch === ';')) {
            skipLine();
            break;
          }
          if (ch === '\\') {
            const next = s[i++];
            if (next === '\r' && s[i] === '\n') i++;
            else if (next === 'n') pending += '\n';
            else if (next === 't') pending += '\t';
            else if (next === 'b') pending += '\b';
            else if (next !== '\n' && next !== undefined) pending += next;
            value += pending;
            pending = '';
          } else if (ch === '"') {
            quoted = !quoted;
            value += pending;
            pending = '';
          } else if (!quoted && (ch === ' ' || ch === '\t')) {
            // Spaces count only before something else (trailing ones are dropped).
            if (value) pending += ch;
          } else {
            value += pending + ch;
            pending = '';
          }
        }
      } else if (s[i] !== undefined && s[i] !== '\n' && s[i] !== '\r' && s[i] !== '#' && s[i] !== ';') {
        // Not a key git accepts: git refuses the whole file, so nothing runs; skip the line.
        skipLine();
        continue;
      }
      if (section) entries.push([`${section}.${name.toLowerCase()}`, value]);
    } else {
      skipLine();
    }
  }
  return entries;
}

/** Git's boolean "true": true, yes, on or a non-zero number. */
function isTrue(value: string): boolean {
  const text = value.trim().toLowerCase();
  return /^(true|yes|on)$/.test(text) || (/^-?\d+[kmg]?$/.test(text) && parseInt(text, 10) !== 0);
}

/**
 * The repositories git may use for a command started in `dir`: the nearest .git (a folder, or a
 * file naming one) or bare repository above it. A .git folder git would not accept (no valid HEAD,
 * objects or refs) does not stop git, so the search goes on and both count.
 */
async function reposOf(dir: string): Promise<Repo[]> {
  const repos: Repo[] = [];
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const repo = await repoAt(current);
    if (repo) {
      repos.push(repo);
      if (repo.gitDir !== path.join(current, '.git') || (await isGitDir(repo.gitDir))) return repos;
    } else if (await isGitDir(current)) {
      // A bare repository: git log and show work in it.
      return [...repos, { top: current, gitDir: current, commonDir: await commonDirOf(current), configs: [path.join(current, 'config')] }];
    }
    if (path.dirname(current) === current) return repos;
  }
}

/** The repository whose worktree is `dir`: it has a .git folder, or a .git file naming one. */
async function repoAt(dir: string): Promise<Repo | undefined> {
  const dotGit = path.join(dir, '.git');
  // One read tells both: a folder (EISDIR) is the git dir itself, a file points to one.
  const content = await fs.readFile(dotGit, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'EISDIR' ? null : undefined));
  if (content === undefined) return undefined;
  if (content === null) {
    const commonDir = await commonDirOf(dotGit);
    return { top: dir, gitDir: dotGit, commonDir, configs: [...new Set([path.join(commonDir, 'config'), path.join(dotGit, 'config'), path.join(dotGit, 'config.worktree')])] };
  }
  // A worktree or submodule: ".git" names the real git dir, which may share a common one. A
  // pointer git cannot follow stops git with an error: nothing runs.
  const pointer = /^gitdir:\s*(.+)$/m.exec(content)?.[1].trim();
  const gitDir = pointer ? path.resolve(dir, pointer) : dotGit;
  const commonDir = pointer ? await commonDirOf(gitDir) : dotGit;
  return { top: dir, gitDir, commonDir, configs: pointer ? [...new Set([path.join(commonDir, 'config'), path.join(gitDir, 'config'), path.join(gitDir, 'config.worktree')])] : [] };
}

async function commonDirOf(gitDir: string): Promise<string> {
  const common = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
  return common ? path.resolve(gitDir, common) : gitDir;
}

/** A folder git accepts as a repository: a HEAD that names a ref or a commit, objects and refs. */
async function isGitDir(dir: string): Promise<boolean> {
  const head = await fs.readFile(path.join(dir, 'HEAD'), 'utf8').catch(() => '');
  if (!/^(ref:\s*refs\/|[0-9a-f]{40}([0-9a-f]{24})?\s*$)/i.test(head)) return false;
  const common = await commonDirOf(dir);
  return (await lexists(path.join(common, 'objects'))) && (await lexists(path.join(common, 'refs')));
}

/**
 * The submodules (gitlinks) in the repository's index, which git status and diff look into. The
 * index is read directly (versions 2 to 4, and the shared index of a split one).
 */
async function gitlinks(repo: Repo, hashLength: number): Promise<string[]> {
  const links: string[] = [];
  const indexes = [path.join(repo.gitDir, 'index')];
  for (let n = 0; n < indexes.length && n < 2; n++) {
    const data = await fs.readFile(indexes[n]).catch(() => undefined);
    const shared = data && readIndex(data, hashLength, links);
    if (shared) {
      const name = `sharedindex.${shared}`;
      indexes.push((await lexists(path.join(repo.gitDir, name))) ? path.join(repo.gitDir, name) : path.join(repo.commonDir, name));
    }
  }
  return links;
}

/** Add the gitlinks of one index file to `links`; returns the shared index's id when the index is split. */
export function readIndex(data: Buffer, hashLength: number, links: string[]): string | undefined {
  if (data.length < 12 || data.toString('latin1', 0, 4) !== 'DIRC') return undefined;
  const version = data.readUInt32BE(4);
  if (version < 2 || version > 4) return undefined;
  const count = data.readUInt32BE(8);
  let offset = 12;
  let previous = '';
  try {
    for (let n = 0; n < count; n++) {
      const mode = data.readUInt32BE(offset + 24);
      const flags = data.readUInt16BE(offset + 40 + hashLength);
      let start = offset + 42 + hashLength + (version >= 3 && flags & 0x4000 ? 2 : 0);
      let name: string;
      if (version === 4) {
        // The name is the previous one less `strip` characters, plus what follows (git's varint).
        let byte = data[start++];
        let strip = byte & 0x7f;
        while (byte & 0x80) {
          byte = data[start++];
          strip = (strip + 1) * 128 + (byte & 0x7f);
        }
        const end = data.indexOf(0, start);
        if (end < 0) return undefined;
        name = previous.slice(0, Math.max(0, previous.length - strip)) + data.toString('utf8', start, end);
        offset = end + 1;
      } else {
        const end = data.indexOf(0, start);
        if (end < 0) return undefined;
        name = data.toString('utf8', start, end);
        // Entries are padded with NULs to a multiple of 8 bytes.
        offset += (end - offset + 8) & ~7;
      }
      if ((mode & 0xf000) === 0xe000) links.push(name);
      previous = name;
    }
    // Extensions: a split index names its shared index in "link".
    while (offset + 8 <= data.length - hashLength) {
      const size = data.readUInt32BE(offset + 4);
      if (data.toString('latin1', offset, offset + 4) === 'link') return data.toString('hex', offset + 8, offset + 8 + hashLength);
      offset += 8 + size;
    }
  } catch {
    // A truncated index: git refuses it too.
  }
  return undefined;
}

/** The path exists, as a file, a folder or a link (even one whose target is missing). */
async function lexists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** How a read-only git tool is classified: safe, unless the repository's config makes git run programs. */
async function gitReadAction(root: string, title: string): Promise<ToolAction> {
  const risky = riskForHardenedGit(await gitConfigRisk(root));
  if (!risky.length) return { category: 'read', risk: 'safe', title };
  return { category: 'command', risk: 'dangerous', title, detail: `This repository's git config makes git run programs (${risky.join(', ')}).` };
}

export const gitStatusTool: Tool<Record<string, never>> = {
  name: 'git_status',
  description: 'Show the current branch and the working tree status (changed, staged and untracked files).',
  inputSchema: { type: 'object', properties: {} },
  describe: (_input, ctx) => gitReadAction(ctx.host.workspaceRoot, 'git status'),
  async execute(_input, ctx) {
    const out = await runGit(ctx.host.workspaceRoot, ['status', '--short', '--branch'], ctx.signal);
    return { content: out.trim() || 'Clean working tree.' };
  },
};

interface GitDiffInput {
  path?: string;
  staged?: boolean;
  ref?: string;
}

export const gitDiffTool: Tool<GitDiffInput> = {
  name: 'git_diff',
  description:
    'Show a unified diff of uncommitted changes (working tree vs HEAD by default). ' +
    'Set staged to see the index, or ref to compare against a commit/branch. Optionally limit to one path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      staged: { type: 'boolean' },
      ref: { type: 'string', description: 'Commit, tag or branch to diff against, e.g. "HEAD~1" or "main".' },
    },
  },
  describe: (input, ctx) => gitReadAction(ctx.host.workspaceRoot, `git diff${input.path ? ` ${input.path}` : ''}`),
  async execute(input, ctx) {
    // A submodule's diff (diff.submodule=diff) is a git of its own that runs its drivers anyway.
    const args = ['diff', '--no-color', '--submodule=short'];
    if (input.staged) args.push('--staged');
    if (input.ref) {
      if (input.ref.startsWith('-')) throw new ToolError('ref must not start with "-".');
      args.push(input.ref);
    }
    if (input.path) args.push('--', toRelative(ctx.host.workspaceRoot, resolveInWorkspace(ctx.host.workspaceRoot, input.path)));
    const out = await runGit(ctx.host.workspaceRoot, args, ctx.signal);
    return { content: truncateMiddle(out.trim(), MAX_GIT_OUTPUT) || 'No differences.' };
  },
};

interface GitLogInput {
  count?: number;
  path?: string;
}

export const gitLogTool: Tool<GitLogInput> = {
  name: 'git_log',
  description: 'Show recent commits (hash, date, author, subject), optionally for one path.',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of commits (default 15).' },
      path: { type: 'string' },
    },
  },
  describe: (_input, ctx) => gitReadAction(ctx.host.workspaceRoot, 'git log'),
  async execute(input, ctx) {
    // Checking signatures (log.showSignature) would run the gpg program the repository names.
    const args = ['log', '--no-show-signature', `-${input.count ?? 15}`, '--date=short', '--pretty=format:%h %ad %an: %s'];
    if (input.path) args.push('--', toRelative(ctx.host.workspaceRoot, resolveInWorkspace(ctx.host.workspaceRoot, input.path)));
    const out = await runGit(ctx.host.workspaceRoot, args, ctx.signal);
    return { content: out.trim() || 'No commits yet.' };
  },
};

export const gitBranchTool: Tool<Record<string, never>> = {
  name: 'git_branch',
  description: 'List local and remote branches and show which one is checked out.',
  inputSchema: { type: 'object', properties: {} },
  describe: (_input, ctx) => gitReadAction(ctx.host.workspaceRoot, 'git branch'),
  async execute(_input, ctx) {
    const out = await runGit(ctx.host.workspaceRoot, ['branch', '-a', '--no-color', '-vv'], ctx.signal);
    return { content: out.trim() || 'No branches yet.' };
  },
};
