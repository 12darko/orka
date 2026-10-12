import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
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
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.fsmonitor=false', command, ...noDrivers, ...rest], { cwd, maxBuffer: 20_000_000, signal, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || error.message).trim();
        reject(new ToolError(/not a git repository/i.test(message) ? 'This workspace is not a git repository.' : message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Keys in a repository's own git config that make git start a program. */
const RISKY_KEY = /^(core\.fsmonitor|core\.hookspath|core\.sshcommand|diff\.external|diff\..+\.(textconv|command)|filter\..+\.(clean|smudge|process)|include\.path|includeif\..+\.path)$/;

/**
 * Settings in the workspace repository's own config that make git start programs (a downloaded
 * project can ship a .git/config with an fsmonitor hook or a filter). Git LFS filters and the
 * built-in fsmonitor are fine. Returns the risky keys, empty when there are none.
 */
export async function gitConfigRisk(root: string): Promise<string[]> {
  const risky = new Set<string>();
  for (const file of await repoConfigFiles(root)) {
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const header = /^\[\s*([^\s\]"]+)(?:\s+"([^"]*)")?\s*\]/.exec(line);
      if (header) {
        section = header[1].toLowerCase() + (header[2] !== undefined ? `.${header[2].toLowerCase()}` : '');
        continue;
      }
      const entry = /^([A-Za-z][\w-]*)\s*(?:=\s*(.*))?$/.exec(line);
      if (!entry || !section) continue;
      const key = `${section}.${entry[1].toLowerCase()}`;
      const value = (entry[2] ?? 'true').trim().replace(/^"(.*)"$/, '$1');
      if (!RISKY_KEY.test(key)) continue;
      if (key === 'core.fsmonitor' && /^(true|false|yes|no|on|off|0|1|)$/i.test(value)) continue;
      if (key.startsWith('filter.') && /^git[- ]lfs\b/i.test(value)) continue;
      risky.add(key);
    }
  }
  return [...risky];
}

/** Of those keys, the ones that still matter for Orka's own hardened git calls (filters run on status and diff). */
export function riskForHardenedGit(keys: readonly string[]): string[] {
  return keys.filter((k) => k.startsWith('filter.') || k.startsWith('include'));
}

/** The repository config files git reads for this workspace (the repository may be a parent folder). */
async function repoConfigFiles(root: string): Promise<string[]> {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    const stat = await fs.stat(dotGit).catch(() => undefined);
    if (stat?.isDirectory()) return [path.join(dotGit, 'config'), path.join(dotGit, 'config.worktree')];
    if (stat?.isFile()) {
      // A worktree or submodule: ".git" names the real git dir, which may share a common one.
      const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8').catch(() => ''))?.[1].trim();
      if (!pointer) return [];
      const gitDir = path.resolve(dir, pointer);
      const common = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
      return [path.join(gitDir, 'config'), path.join(gitDir, 'config.worktree'), ...(common ? [path.join(path.resolve(gitDir, common), 'config')] : [])];
    }
    if (path.dirname(dir) === dir) return [];
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
    const args = ['diff', '--no-color'];
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
    const args = ['log', `-${input.count ?? 15}`, '--date=short', '--pretty=format:%h %ad %an: %s'];
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
