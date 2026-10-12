import { t } from '../i18n';
import type { Tool } from './Tool';
import { ToolError } from './Tool';
import * as path from 'node:path';
import { IGNORED_DIRS, isProbablyBinaryPath, looksBinary, resolveInWorkspace, toRelative } from './workspace';

const MAX_READ_LINES = 1500;
const MAX_FILE_BYTES = 2_000_000;

interface ReadFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

export const readFileTool: Tool<ReadFileInput> = {
  name: 'read_file',
  description:
    'Read a text file from the workspace. Returns lines prefixed with their 1-based line numbers ("12| code"). ' +
    `Large files are returned ${MAX_READ_LINES} lines at a time; use start_line/end_line to read further. ` +
    'Line-number prefixes are not part of the file - never include them in edit_file strings.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      start_line: { type: 'integer', minimum: 1, description: 'First line to read (1-based). Optional.' },
      end_line: { type: 'integer', minimum: 1, description: 'Last line to read (inclusive). Optional.' },
    },
    required: ['path'],
  },
  describe: (input, ctx) => ({ category: 'read', risk: 'safe', title: t('Read {path}', { path: display(ctx.host.workspaceRoot, input.path) }) }),
  async execute(input, ctx) {
    const abs = resolveInWorkspace(ctx.host.workspaceRoot, input.path);
    if (!(await ctx.host.exists(abs))) throw new ToolError(`File not found: ${input.path}`);
    if (await ctx.host.isDirectory(abs)) throw new ToolError(`${input.path} is a directory; use list_directory.`);
    if (isProbablyBinaryPath(abs)) throw new ToolError(`${input.path} looks like a binary file; not reading it.`);
    const size = await ctx.host.fileSize(abs);
    if (size > MAX_FILE_BYTES) {
      throw new ToolError(`${input.path} is ${(size / 1e6).toFixed(1)} MB - too large. Use search_code to find the relevant part.`);
    }
    const text = await ctx.host.readFile(abs);
    if (looksBinary(text)) throw new ToolError(`${input.path} looks like a binary file; not reading it.`);
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, input.start_line ?? 1);
    const requestedEnd = input.end_line ?? start + MAX_READ_LINES - 1;
    const end = Math.min(lines.length, requestedEnd, start + MAX_READ_LINES - 1);
    if (start > lines.length) return { content: `(file has only ${lines.length} lines)` };
    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(width)}| ${line}`)
      .join('\n');
    const header = `${toRelative(ctx.host.workspaceRoot, abs)} (lines ${start}-${end} of ${lines.length})`;
    const more = end < lines.length ? `\n... ${lines.length - end} more lines. Call read_file with start_line=${end + 1} to continue.` : '';
    return { content: `${header}\n${body}${more}` };
  },
};

interface WriteFileInput {
  path: string;
  content: string;
}

export const writeFileTool: Tool<WriteFileInput> = {
  name: 'write_file',
  description:
    'Create a new file, or completely replace an existing file, with the given content. Parent folders are created. ' +
    'For small changes to an existing file prefer edit_file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      content: { type: 'string', description: 'The complete file content.' },
    },
    required: ['path', 'content'],
  },
  async describe(input, ctx) {
    const abs = resolveInWorkspace(ctx.host.workspaceRoot, input.path);
    const exists = await ctx.host.exists(abs);
    const before = exists ? await ctx.host.readFile(abs) : null;
    return {
      category: 'edit',
      risk: 'normal',
      title: exists ? t('Overwrite {path}', { path: toRelative(ctx.host.workspaceRoot, abs) }) : t('Create {path}', { path: toRelative(ctx.host.workspaceRoot, abs) }),
      preview: { path: abs, before, after: input.content },
    };
  },
  async execute(input, ctx) {
    const abs = resolveInWorkspace(ctx.host.workspaceRoot, input.path);
    if (await ctx.host.isDirectory(abs)) throw new ToolError(`${input.path} is a directory.`);
    const existed = await ctx.host.exists(abs);
    let content = input.content;
    if (existed) {
      const current = await ctx.host.readFile(abs);
      content = matchLineEndings(current, content);
    }
    await ctx.changes.recordBefore(abs);
    await ctx.host.writeFile(abs, content);
    ctx.changes.notify();
    const lines = content.split(/\r?\n/).length;
    return { content: `${existed ? 'Updated' : 'Created'} ${toRelative(ctx.host.workspaceRoot, abs)} (${lines} lines).` };
  },
};

interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const editFileTool: Tool<EditFileInput> = {
  name: 'edit_file',
  description:
    'Replace an exact snippet in an existing file. old_string must match the file exactly (including indentation) ' +
    'and must be unique in the file unless replace_all is true - include enough surrounding lines to make it unique. ' +
    'To insert code, include a nearby anchor line in old_string and repeat it in new_string.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      old_string: { type: 'string', description: 'Exact text to replace (non-empty).' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async describe(input, ctx) {
    const abs = resolveInWorkspace(ctx.host.workspaceRoot, input.path);
    let preview;
    try {
      const before = await ctx.host.readFile(abs);
      preview = { path: abs, before, after: applyEdit(before, input).content };
    } catch {
      preview = undefined; // execute() reports the precise error
    }
    return { category: 'edit', risk: 'normal', title: t('Edit {path}', { path: toRelative(ctx.host.workspaceRoot, abs) }), preview };
  },
  async execute(input, ctx) {
    const abs = resolveInWorkspace(ctx.host.workspaceRoot, input.path);
    if (!(await ctx.host.exists(abs))) {
      throw new ToolError(`File not found: ${input.path}. Use write_file to create new files.`);
    }
    const before = await ctx.host.readFile(abs);
    const { content, count } = applyEdit(before, input);
    await ctx.changes.recordBefore(abs);
    await ctx.host.writeFile(abs, content);
    ctx.changes.notify();
    return {
      content: `Edited ${toRelative(ctx.host.workspaceRoot, abs)}: replaced ${count} occurrence${count === 1 ? '' : 's'}.`,
    };
  },
};

interface DeleteFileInput {
  path: string;
}

export const deleteFileTool: Tool<DeleteFileInput> = {
  name: 'delete_file',
  description: 'Delete a file from the workspace (the user can restore it from the change list).',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to the workspace root.' } },
    required: ['path'],
  },
  async describe(input, ctx) {
    const abs = resolveInWorkspace(ctx.host.workspaceRoot, input.path);
    const before = (await ctx.host.exists(abs)) && !(await ctx.host.isDirectory(abs)) ? await ctx.host.readFile(abs) : null;
    return {
      category: 'delete',
      risk: 'normal',
      title: t('Delete {path}', { path: toRelative(ctx.host.workspaceRoot, abs) }),
      preview: before === null ? undefined : { path: abs, before, after: null },
    };
  },
  async execute(input, ctx) {
    const abs = resolveInWorkspace(ctx.host.workspaceRoot, input.path);
    if (!(await ctx.host.exists(abs))) throw new ToolError(`File not found: ${input.path}`);
    if (await ctx.host.isDirectory(abs)) throw new ToolError(`${input.path} is a directory; only files can be deleted.`);
    await ctx.changes.recordBefore(abs);
    await ctx.host.deleteFile(abs);
    ctx.changes.notify();
    return { content: `Deleted ${toRelative(ctx.host.workspaceRoot, abs)}.` };
  },
};

interface ListDirectoryInput {
  path?: string;
  depth?: number;
}

export const listDirectoryTool: Tool<ListDirectoryInput> = {
  name: 'list_directory',
  description:
    'List files and folders under a directory (default: workspace root). depth 1-4 controls recursion (default 2). ' +
    'Dependency/build folders (node_modules, Library, obj, ...) are shown but not expanded.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory relative to the workspace root. Default ".".' },
      depth: { type: 'integer', minimum: 1, maximum: 4 },
    },
  },
  describe: (input, ctx) => ({ category: 'read', risk: 'safe', title: t('List {path}', { path: display(ctx.host.workspaceRoot, input.path || '.') }) }),
  async execute(input, ctx) {
    const root = resolveInWorkspace(ctx.host.workspaceRoot, input.path);
    if (!(await ctx.host.isDirectory(root))) throw new ToolError(`Not a directory: ${input.path ?? '.'}`);
    const maxDepth = input.depth ?? 2;
    const lines: string[] = [];
    const LIMIT = 500;
    const walk = async (dir: string, depth: number, indent: string) => {
      const entries = (await ctx.host.listDir(dir)).sort((a, b) =>
        a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
      );
      for (const entry of entries) {
        if (lines.length >= LIMIT) return;
        if (entry.isDirectory) {
          const skipped = IGNORED_DIRS.has(entry.name);
          lines.push(`${indent}${entry.name}/${skipped ? ' (not expanded)' : ''}`);
          if (!skipped && depth < maxDepth) await walk(path.join(dir, entry.name), depth + 1, `${indent}  `);
        } else {
          lines.push(`${indent}${entry.name}`);
        }
      }
    };
    await walk(root, 1, '');
    if (lines.length >= LIMIT) lines.push(`... (truncated at ${LIMIT} entries; list a subdirectory for more)`);
    return { content: `${toRelative(ctx.host.workspaceRoot, root)}/\n${lines.join('\n') || '(empty)'}` };
  },
};

function display(root: string, inputPath: string): string {
  try {
    return toRelative(root, resolveInWorkspace(root, inputPath));
  } catch {
    return inputPath;
  }
}

/** Apply an exact-match replacement, tolerating CRLF files when the model sent LF snippets. */
export function applyEdit(
  content: string,
  input: { old_string: string; new_string: string; replace_all?: boolean; path?: string },
): { content: string; count: number } {
  if (!input.old_string) throw new ToolError('old_string must not be empty. Use write_file to create or replace whole files.');
  if (input.old_string === input.new_string) throw new ToolError('old_string and new_string are identical; nothing to change.');
  let oldString = input.old_string;
  let newString = input.new_string;
  if (!content.includes(oldString) && content.includes('\r\n')) {
    oldString = oldString.replace(/\r?\n/g, '\r\n');
    newString = newString.replace(/\r?\n/g, '\r\n');
  }
  const count = content.split(oldString).length - 1;
  if (count === 0) {
    throw new ToolError(
      `old_string was not found in ${input.path ?? 'the file'}. It must match exactly, including whitespace and indentation. ` +
        'Re-read the file to get the current text.',
    );
  }
  if (count > 1 && !input.replace_all) {
    throw new ToolError(
      `old_string matches ${count} places in ${input.path ?? 'the file'}. Add surrounding lines to make it unique, or set replace_all.`,
    );
  }
  const replaced = input.replace_all ? content.split(oldString).join(newString) : replaceOnce(content, oldString, newString);
  return { content: replaced, count: input.replace_all ? count : 1 };
}

function replaceOnce(content: string, search: string, replacement: string): string {
  const index = content.indexOf(search);
  return content.slice(0, index) + replacement + content.slice(index + search.length);
}

/** Keep a file's existing line-ending style when it is rewritten. */
function matchLineEndings(existing: string, next: string): string {
  const crlf = existing.includes('\r\n');
  const normalized = next.replace(/\r\n/g, '\n');
  return crlf ? normalized.replace(/\n/g, '\r\n') : normalized;
}
