// Builds Orka Desktop as one executable that runs without Node installed: dist/orka-desktop.exe
// (dist/orka-desktop on Linux and macOS), a Node single executable application (SEA).
// The bundle is its main script; the files it reads from dist (chat UI, theme, icon, built-in
// skills) go in as assets, which src/sea.ts extracts on the first start. The executable is a copy
// of the Node that runs this script, so run it with the Node version you want to ship.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from 'postject';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const work = path.join(dist, 'sea');
const main = path.join(dist, 'orka-desktop.js');
const exe = path.join(dist, process.platform === 'win32' ? 'orka-desktop.exe' : 'orka-desktop');
// Must match src/sea.ts.
const MANIFEST_ASSET = 'orka-manifest.json';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) fail(`Node ${process.versions.node} cannot add assets to an executable; use Node 20.12 or newer.`);
if (!process.config.variables.single_executable_application) fail('This Node build cannot make single executable applications; use an official build from nodejs.org.');

// 1. The app, minified and without source maps.
execFileSync(process.execPath, ['esbuild.mjs', '--production'], { cwd: root, stdio: 'inherit' });

// 2. Every file next to the bundle becomes an asset, plus a manifest that lists them with a
//    content hash (the name of the folder they are extracted to).
const files = walk(dist)
  .map((file) => path.relative(dist, file).split(path.sep).join('/'))
  .filter((name) => name !== 'orka-desktop.js' && !name.endsWith('.map'))
  .sort();
const hash = createHash('sha256');
for (const name of files) hash.update(name).update('\0').update(readFileSync(path.join(dist, name))).update('\0');
const manifest = { hash: hash.digest('hex').slice(0, 12), files };

mkdirSync(work, { recursive: true });
const manifestFile = path.join(work, 'manifest.json');
writeFileSync(manifestFile, JSON.stringify(manifest));
const blob = path.join(work, 'orka-desktop.blob');
const config = path.join(work, 'sea-config.json');
writeFileSync(
  config,
  JSON.stringify(
    {
      main,
      output: blob,
      disableExperimentalSEAWarning: true,
      assets: { [MANIFEST_ASSET]: manifestFile, ...Object.fromEntries(files.map((name) => [name, path.join(dist, name)])) },
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', config], { cwd: root, stdio: 'inherit' });

// 3. A copy of this Node with the blob injected. Its signature no longer matches afterwards:
//    remove it where a tool is at hand (signtool is optional on Windows, required on macOS).
copyFileSync(process.execPath, exe);
if (process.platform === 'win32') tryRun('signtool', ['remove', '/s', exe]);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });
await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: FUSE,
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
});
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });

rmSync(work, { recursive: true, force: true });
console.log(`[sea] ${path.relative(root, exe)} (${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB, ${files.length} assets, Node ${process.versions.node})`);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Runs a tool if it is installed. */
function tryRun(file, args) {
  if (spawnSync(file, args, { stdio: 'inherit' }).error) console.log(`[sea] ${file} not found; skipped.`);
}

function fail(message) {
  console.error(`[sea] ${message}`);
  process.exit(1);
}
