import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/** The asset that lists the others (Node 22's node:sea cannot list assets); see scripts/build-exe.mjs. */
export const MANIFEST_ASSET = 'orka-manifest.json';

interface Manifest {
  /** Short hash of every asset's name and content. */
  hash: string;
  /** Asset names, which are also their paths relative to dist ("skills/testing.md"). */
  files: string[];
}

type Sea = typeof import('node:sea');

/** node:sea when running as the single-file executable (orka-desktop.exe), else undefined. */
function singleExecutable(): Sea | undefined {
  try {
    const sea = require('node:sea') as Sea;
    return sea.isSea() ? sea : undefined;
  } catch {
    return undefined; // Node before 20.12
  }
}

/**
 * The folder with the files the app reads at runtime (the chat UI, theme.css, icon.png, built-in
 * skills): dist, next to the script. The single-file executable carries them as assets instead and
 * extracts them on its first start into <home>/desktop/runtime/<version>-<hash>.
 */
export function appDir(home: string, version: string): string {
  const sea = singleExecutable();
  if (!sea) return __dirname;
  const manifest = JSON.parse(sea.getAsset(MANIFEST_ASSET, 'utf8')) as Manifest;
  const dir = path.join(home, 'desktop', 'runtime', `${version}-${manifest.hash}`);
  if (existsSync(dir)) return dir;
  // Extract next to it, then rename into place: the folder only ever exists complete, even when
  // two instances start at once.
  const tmp = `${dir}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  for (const file of manifest.files) {
    const target = path.join(tmp, ...file.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(sea.getAsset(file)));
  }
  try {
    renameSync(tmp, dir);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(dir)) throw error; // otherwise another instance was first
  }
  return dir;
}
