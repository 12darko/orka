import { t } from '../i18n';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { Host } from '../host/Host';
import type { Tool } from './Tool';
import { ToolError } from './Tool';
import {
  escapeRegExp,
  globToRegExp,
  IGNORED_DIRS,
  isProbablyBinaryPath,
  looksBinary,
  resolveInWorkspace,
  toRelative,
  walkFiles,
} from './workspace';

const MAX_LINE_CHARS = 300;
const MAX_SEARCH_FILE_BYTES = 1_000_000;

interface SearchFilesInput {
  pattern: string;
  path?: string;
  max_results?: number;
}

export const searchFilesTool: Tool<SearchFilesInput> = {
  name: 'search_files',
  description:
    'Find files by name or glob pattern, e.g. "PlayerController.cs", "*.test.ts", "src/**/lobby*". ' +
    'A pattern without "/" matches at any depth. Returns workspace-relative paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'File name or glob.' },
      path: { type: 'string', description: 'Directory to search in (default: workspace root).' },
      max_results: { type: 'integer', minimum: 1, maximum: 1000 },
    },
    required: ['pattern'],
  },
  describe: (input) => ({ category: 'read', risk: 'safe', title: t('Find files "{pattern}"', { pattern: input.pattern }) }),
  async execute(input, ctx) {
    const root = ctx.host.workspaceRoot;
    const base = resolveInWorkspace(root, input.path);
    const max = input.max_results ?? 200;
    const matcher = globToRegExp(input.pattern);
    const results: string[] = [];
    for await (const file of walkFiles(ctx.host, base, { signal: ctx.signal })) {
      const rel = toRelative(base, file);
      if (matcher.test(rel)) {
        results.push(toRelative(root, file));
        if (results.length >= max) break;
      }
    }
    if (!results.length) return { content: `No files match "${input.pattern}".` };
    const more = results.length >= max ? `\n(limited to ${max} results - narrow the pattern)` : '';
    return { content: results.join('\n') + more };
  },
};

interface SearchCodeInput {
  query: string;
  is_regex?: boolean;
  case_sensitive?: boolean;
  path?: string;
  glob?: string;
  max_results?: number;
}

export const searchCodeTool: Tool<SearchCodeInput> = {
  name: 'search_code',
  description:
    'Search file contents across the workspace (like grep). Returns "path:line: text" matches. ' +
    'Use it to locate symbols, usages and relevant code before reading files. ' +
    'Plain text by default; set is_regex for regular expressions (e.g. "class \\\\w+Lobby"). ' +
    'Use glob to restrict file types, e.g. "*.cs".',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text or regular expression to search for.' },
      is_regex: { type: 'boolean' },
      case_sensitive: { type: 'boolean', description: 'Default false.' },
      path: { type: 'string', description: 'Directory or file to search (default: workspace root).' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts" or "src/**/*.cs".' },
      max_results: { type: 'integer', minimum: 1, maximum: 500 },
    },
    required: ['query'],
  },
  describe: (input) => ({ category: 'read', risk: 'safe', title: input.glob ? t('Search "{query}" in {glob}', { query: input.query, glob: input.glob }) : t('Search "{query}"', { query: input.query }) }),
  async execute(input, ctx) {
    if (!input.query) throw new ToolError('query must not be empty.');
    const max = input.max_results ?? 100;
    let lines: string[];
    if (ctx.host.ripgrepPath) {
      try {
        lines = await ripgrep(ctx.host, input, max, ctx.signal);
      } catch {
        lines = await nodeSearch(ctx.host, input, max, ctx.signal);
      }
    } else {
      lines = await nodeSearch(ctx.host, input, max, ctx.signal);
    }
    if (!lines.length) return { content: `No matches for "${input.query}".` };
    const more = lines.length >= max ? `\n(limited to ${max} matches - refine the query, path or glob)` : '';
    return { content: lines.join('\n') + more };
  },
};

function buildMatcher(input: SearchCodeInput): RegExp {
  const flags = input.case_sensitive ? '' : 'i';
  try {
    return new RegExp(input.is_regex ? input.query : escapeRegExp(input.query), flags);
  } catch (error) {
    throw new ToolError(`Invalid regular expression: ${(error as Error).message}`);
  }
}

async function nodeSearch(host: Host, input: SearchCodeInput, max: number, signal: AbortSignal): Promise<string[]> {
  const root = host.workspaceRoot;
  const target = resolveInWorkspace(root, input.path);
  const matcher = buildMatcher(input);
  const globRe = input.glob ? globToRegExp(input.glob) : undefined;
  const files = (await host.isDirectory(target)) ? walkFiles(host, target, { signal }) : single(target);
  const results: string[] = [];
  for await (const file of files) {
    if (isProbablyBinaryPath(file)) continue;
    const rel = toRelative(root, file);
    if (globRe && !globRe.test(rel)) continue;
    try {
      if ((await host.fileSize(file)) > MAX_SEARCH_FILE_BYTES) continue;
      const text = await host.readFile(file);
      if (looksBinary(text)) continue;
      const fileLines = text.split(/\r?\n/);
      for (let i = 0; i < fileLines.length; i++) {
        if (matcher.test(fileLines[i])) {
          results.push(`${rel}:${i + 1}: ${clip(fileLines[i].trim())}`);
          if (results.length >= max) return results;
        }
      }
    } catch {
      /* unreadable file - skip */
    }
  }
  return results;
}

async function* single(file: string): AsyncGenerator<string> {
  yield file;
}

function ripgrep(host: Host, input: SearchCodeInput, max: number, signal: AbortSignal): Promise<string[]> {
  const root = host.workspaceRoot;
  const target = resolveInWorkspace(root, input.path);
  const args = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', String(MAX_LINE_CHARS), '--max-filesize', '1M'];
  if (!input.case_sensitive) args.push('--ignore-case');
  if (!input.is_regex) args.push('--fixed-strings');
  for (const dir of IGNORED_DIRS) args.push('--glob', `!${dir}/`);
  if (input.glob) args.push('--glob', input.glob.includes('/') ? input.glob : `**/${input.glob}`);
  args.push('--', input.query, path.relative(root, target) || '.');
  return new Promise((resolve, reject) => {
    execFile(host.ripgrepPath!, args, { cwd: root, maxBuffer: 20_000_000, signal, windowsHide: true }, (error, stdout) => {
      // Exit code 1 = no matches.
      if (error && (error as { code?: unknown }).code !== 1) {
        if (!stdout) return reject(error);
      }
      const lines = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, max)
        .map((line) => {
          const m = /^(.*?):(\d+):(.*)$/.exec(line);
          return m ? `${m[1].split(path.sep).join('/')}:${m[2]}: ${clip(m[3].trim())}` : line;
        });
      resolve(lines);
    });
  });
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line;
}
