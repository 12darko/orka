import * as path from 'node:path';
import { t } from '../i18n';
import type { Tool } from './Tool';
import { ToolError, truncateMiddle } from './Tool';
import { isProbablyBinaryPath, resolveInWorkspace, toRelative, walkFiles } from './workspace';

const MAX_FILES = 60;
const MAX_FILE_BYTES = 400_000;
const MAX_OUTPUT = 30_000;

interface OutlineInput {
  path: string;
}

/**
 * Declarations per language: [pattern, kind]. Regex-based on purpose - fast, dependency-free and
 * good enough to see a file's shape (classes, methods, functions) with line numbers.
 */
const RULES: Array<{ ext: RegExp; rules: Array<[RegExp, string]> }> = [
  {
    ext: /\.cs$/i,
    rules: [
      [/^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|unsafe|new)\s+)*(class|struct|interface|enum|record)\s+(\w+)/, '$1 $2'],
      [/^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|new)\s+)+[\w<>[\],.?\s]+?\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)?/, '$1($3)'],
    ],
  },
  {
    ext: /\.(ts|tsx|js|jsx|mjs|cjs)$/i,
    rules: [
      [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|type)\s+(\w+)/, '$1 $2'],
      [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)\s*\(([^)]*)\)?/, 'function $1($2)'],
      [/^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/, 'const $1 = () =>'],
      [/^\s{2,4}(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{\s*$/, '$1($2)'],
    ],
  },
  {
    ext: /\.py$/i,
    rules: [
      [/^\s*class\s+(\w+)/, 'class $1'],
      [/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)?/, '$1def $2($3)'],
    ],
  },
  { ext: /\.go$/i, rules: [[/^\s*func\s+(\([^)]*\)\s*)?(\w+)\s*\(([^)]*)\)?/, 'func $1$2($3)'], [/^\s*type\s+(\w+)\s+(struct|interface)/, 'type $1 $2']] },
  {
    ext: /\.(java|kt|kts)$/i,
    rules: [
      [/^\s*(?:(?:public|private|protected|static|final|abstract|open|data|sealed|internal)\s+)*(class|interface|enum|object|record)\s+(\w+)/, '$1 $2'],
      [/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|override|suspend|open|internal)\s+)+(?:fun\s+)?[\w<>[\],.?\s]*?(\w+)\s*\(([^)]*)\)?/, '$1($2)'],
    ],
  },
  { ext: /\.rs$/i, rules: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|impl|mod)\s+([\w<>:, ]+)/, '$1 $2'], [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(([^)]*)\)?/, 'fn $1($2)']] },
  { ext: /\.(c|cc|cpp|cxx|h|hpp)$/i, rules: [[/^\s*(class|struct|enum|namespace)\s+(\w+)/, '$1 $2'], [/^[\w:<>*&\s]+?\b(\w+(?:::\w+)?)\s*\(([^;]*)\)\s*(?:const)?\s*\{?\s*$/, '$1($2)']] },
];

const SKIP_WORDS = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'using', 'lock', 'new', 'else', 'do', 'try', 'await', 'typeof', 'sizeof', 'nameof']);

/** The outline of one file's text, one line per declaration, or undefined for unsupported types. */
export function outlineText(fileName: string, text: string): string[] | undefined {
  const lang = RULES.find((r) => r.ext.test(fileName));
  if (!lang) return undefined;
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400 || /^\s*(\/\/|#|\*|\/\*)/.test(line)) continue;
    for (const [re, template] of lang.rules) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[1] && !/^\s*$/.test(m[1]) ? m[1] : m[2];
      if (name && SKIP_WORDS.has(name.trim())) break;
      const decl = template.replace(/\$(\d)/g, (_, n: string) => (m[Number(n)] ?? '').replace(/\s+/g, ' ').trim()).replace(/\s+/g, ' ');
      const indent = Math.min(8, (/^\s*/.exec(line)?.[0].replace(/\t/g, '    ').length ?? 0));
      out.push(`${String(i + 1).padStart(5)}  ${' '.repeat(Math.floor(indent / 2))}${decl.length > 140 ? `${decl.slice(0, 137)}...` : decl}`);
      break;
    }
  }
  return out;
}

export const codeOutlineTool: Tool<OutlineInput> = {
  name: 'code_outline',
  description:
    'Show the structure of a source file or folder - classes, methods, functions with line numbers - without reading every line. ' +
    'Use it first to find what you need in large files or folders, then read_file only the relevant line ranges. ' +
    'Supports C#, TypeScript/JavaScript, Python, Go, Java/Kotlin, Rust and C/C++.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'A file or folder, relative to the workspace root.' } },
    required: ['path'],
  },
  describe: (input, ctx) => ({ category: 'read', risk: 'safe', title: t('Outline {path}', { path: toRelative(ctx.host.workspaceRoot, resolveInWorkspace(ctx.host.workspaceRoot, input.path)) }) }),
  async execute(input, ctx) {
    const root = ctx.host.workspaceRoot;
    const target = resolveInWorkspace(root, input.path);
    if (!(await ctx.host.exists(target))) throw new ToolError(`Not found: ${input.path}`);
    const files: string[] = [];
    if (await ctx.host.isDirectory(target)) {
      for await (const file of walkFiles(ctx.host, target, { maxFiles: 5000, signal: ctx.signal })) {
        if (RULES.some((r) => r.ext.test(file)) && !isProbablyBinaryPath(file)) files.push(file);
        if (files.length >= MAX_FILES) break;
      }
    } else files.push(target);
    const sections: string[] = [];
    for (const file of files.sort()) {
      if (ctx.signal.aborted) break;
      if ((await ctx.host.fileSize(file)) > MAX_FILE_BYTES) {
        sections.push(`${toRelative(root, file)}: (too large to outline)`);
        continue;
      }
      const outline = outlineText(path.basename(file), await ctx.host.readFile(file));
      if (outline === undefined) sections.push(`${toRelative(root, file)}: (no outline for this file type)`);
      else sections.push(`${toRelative(root, file)}${outline.length ? `\n${outline.join('\n')}` : ': (no declarations found)'}`);
    }
    if (!sections.length) return { content: 'No supported source files here.' };
    const more = files.length >= MAX_FILES ? `\n\n(stopped after ${MAX_FILES} files; outline a subfolder for more)` : '';
    return { content: truncateMiddle(sections.join('\n\n'), MAX_OUTPUT) + more };
  },
};
