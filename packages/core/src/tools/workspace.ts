import * as path from 'node:path';
import type { Host } from '../host/Host';
import { ToolError } from './Tool';

/**
 * Directories that are never worth walking: dependency caches, build output, VCS internals and
 * engine-generated folders (Unity's Library/Temp/Logs are huge and machine-generated).
 */
export const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vs',
  '.idea',
  '.gradle',
  'bin',
  'obj',
  'target',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  '.tox',
  'Library',
  'Temp',
  'Logs',
  'UserSettings',
  'MemoryCaptures',
  'Builds',
  '.vscode-test',
]);

const BINARY_EXTENSIONS = new Set(
  (
    'png jpg jpeg gif bmp ico webp tga psd tif tiff exr hdr dds ktx ' +
    'mp3 wav ogg flac aac mp4 mov avi mkv webm ' +
    'zip gz tgz bz2 7z rar jar war nupkg ' +
    'exe dll so dylib a lib o obj pdb class wasm bin dat ' +
    'pdf doc docx xls xlsx ppt pptx ' +
    'ttf otf woff woff2 eot ' +
    'fbx blend obj3d glb gltf-binary unitypackage asset-binary bundle ' +
    'sqlite db lock-binary'
  ).split(/\s+/),
);

export function isProbablyBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).slice(1).toLowerCase());
}

export function looksBinary(content: string): boolean {
  return content.slice(0, 8000).includes('\u0000');
}

/** Resolve a model-supplied path and refuse anything that escapes the workspace root. */
export function resolveInWorkspace(root: string, inputPath: string | undefined): string {
  const raw = (inputPath ?? '.').trim() || '.';
  const resolved = path.resolve(root, raw);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ToolError(`Path "${raw}" is outside the workspace (${root}).`);
  }
  return resolved;
}

export function toRelative(root: string, absPath: string): string {
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  return rel || '.';
}

export interface WalkOptions {
  maxFiles?: number;
  signal?: AbortSignal;
}

/** Breadth-first walk of files under `start`, skipping ignored and hidden-noise directories. */
export async function* walkFiles(host: Host, start: string, options: WalkOptions = {}): AsyncGenerator<string> {
  const maxFiles = options.maxFiles ?? 50_000;
  const queue = [start];
  let count = 0;
  while (queue.length) {
    if (options.signal?.aborted) return;
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await host.listDir(dir);
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push(full);
      } else {
        yield full;
        if (++count >= maxFiles) return;
      }
    }
  }
}

/** Convert a glob (`**`, `*`, `?`, `{a,b}`) to a RegExp matched against /-separated relative paths. */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/\\/g, '/');
  // A bare name like "*.cs" or "PlayerController.cs" should match at any depth.
  if (!pattern.includes('/')) pattern = `**/${pattern}`;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end > i) {
        const options = pattern.slice(i + 1, end).split(',').map(escapeRegExp);
        re += `(?:${options.join('|')})`;
        i = end;
      } else re += '\\{';
    } else re += escapeRegExp(c);
  }
  return new RegExp(`^${re}$`, 'i');
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
