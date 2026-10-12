import { execFile } from 'node:child_process';
import type { Tool } from './Tool';
import { ToolError, truncateMiddle } from './Tool';
import { resolveInWorkspace, toRelative } from './workspace';

const MAX_GIT_OUTPUT = 40_000;

export function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 20_000_000, signal, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || error.message).trim();
        reject(new ToolError(/not a git repository/i.test(message) ? 'This workspace is not a git repository.' : message));
      } else {
        resolve(stdout);
      }
    });
  });
}

export const gitStatusTool: Tool<Record<string, never>> = {
  name: 'git_status',
  description: 'Show the current branch and the working tree status (changed, staged and untracked files).',
  inputSchema: { type: 'object', properties: {} },
  describe: () => ({ category: 'read', risk: 'safe', title: 'git status' }),
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
  describe: (input) => ({ category: 'read', risk: 'safe', title: `git diff${input.path ? ` ${input.path}` : ''}` }),
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
  describe: () => ({ category: 'read', risk: 'safe', title: 'git log' }),
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
  describe: () => ({ category: 'read', risk: 'safe', title: 'git branch' }),
  async execute(_input, ctx) {
    const out = await runGit(ctx.host.workspaceRoot, ['branch', '-a', '--no-color', '-vv'], ctx.signal);
    return { content: out.trim() || 'No branches yet.' };
  },
};
