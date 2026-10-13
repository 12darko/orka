// Builds Orka Desktop as one executable that runs without Node installed: dist/orka-desktop.exe
// (dist/orka-desktop on Linux and macOS), a Node single executable application (SEA).
// The bundle is its main script; the files it reads from dist (chat UI, theme, icon, built-in
// skills, third-party notices) go in as assets, which src/sea.ts extracts on the first start. The
// executable is a copy of the Node that runs this script, so run it with the Node version you
// want to ship.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from 'postject';
import * as ResEdit from 'resedit';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const work = path.join(dist, 'sea');
// Relative to root (the folder the blob is made in): Node keeps this path in the executable.
const main = 'dist/orka-desktop.js';
const exe = path.join(dist, process.platform === 'win32' ? 'orka-desktop.exe' : 'orka-desktop');
// Must match src/sea.ts.
const MANIFEST_ASSET = 'orka-manifest.json';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// The app needs Node 22 (see engines), and the executable is this very Node.
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) fail(`Node ${process.versions.node} is too old for Orka Desktop; build it with Node 22 or newer.`);
if (!process.config.variables.single_executable_application) fail('This Node build cannot make single executable applications; use an official build from nodejs.org.');

// 1. The app, minified and without source maps.
execFileSync(process.execPath, ['esbuild.mjs', '--production'], { cwd: root, stdio: 'inherit' });
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// Node is part of the executable: its license (which also covers the OpenSSL, ICU, V8, libuv and
// other code built into it) goes into the notices next to the bundled packages.
appendFileSync(
  path.join(dist, 'THIRD_PARTY_NOTICES.txt'),
  `\n${'-'.repeat(79)}\n\nNode.js ${process.versions.node}, the runtime built into the executable\n` +
    `https://github.com/nodejs/node\n\n${(await nodeLicense()).trim()}\n`,
);

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

// 3. A copy of this Node with the blob injected. Node's signature no longer matches afterwards:
//    macOS needs it removed first and re-signed after. On Windows the copy then gets Orka's name,
//    version and icon (otherwise Explorer, Task Manager and SmartScreen call it "Node.js
//    JavaScript Runtime"), which also drops the signature. That comes after the injection: the
//    injection moves the resources to the end of the file, where changing their size shifts
//    nothing else.
copyFileSync(process.execPath, exe);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });
await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: FUSE,
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
});
if (process.platform === 'win32') brandWindowsExecutable(exe);
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });

rmSync(work, { recursive: true, force: true });
console.log(`[sea] ${path.relative(root, exe)} (${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB, ${files.length} assets, Node ${process.versions.node})`);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Node's LICENSE: next to the binary in the nodejs.org archives, else from the same release tag. */
async function nodeLicense() {
  const dir = path.dirname(process.execPath);
  for (const file of [path.join(dir, 'LICENSE'), path.join(dir, '..', 'LICENSE')]) {
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  // The Windows installer leaves the file out.
  const url = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
  const response = await fetch(url);
  if (!response.ok) fail(`Could not get the Node.js license from ${url} (HTTP ${response.status}).`);
  return response.text();
}

/**
 * Puts Orka's icon and version information into the copied node.exe. resedit writes the file
 * without Node's Authenticode signature, which would no longer match anyway.
 */
function brandWindowsExecutable(file) {
  const binary = ResEdit.NtExecutable.from(readFileSync(file), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(binary);

  const media = path.join(root, '..', 'vscode-extension', 'media');
  const ico = icoFromPngs([path.join(media, 'orka-256.png'), path.join(media, 'orka-128.png')]);
  const icons = ResEdit.Data.IconFile.from(ico).icons.map((icon) => icon.data);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  if (!groups.length) fail(`${file} has no icon to replace.`);
  for (const group of groups) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons);

  const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  if (!info) fail(`${file} has no version information to replace.`);
  const [major, minor, patch] = version.split(/[.-]/).map(Number);
  for (const language of info.getAllLanguagesForStringValues()) {
    info.setFileVersion(major, minor, patch, 0, language.lang);
    info.setProductVersion(major, minor, patch, 0, language.lang);
    info.setStringValues(language, {
      FileDescription: 'Orka Desktop',
      ProductName: 'Orka',
      CompanyName: 'Enophia Software',
      LegalCopyright: 'Copyright (c) 2026 Enophia Software. MIT License. Includes Node.js and other third-party software.',
      OriginalFilename: 'orka-desktop.exe',
      InternalName: 'orka-desktop',
      FileVersion: version,
      ProductVersion: version,
    });
  }
  info.outputToResourceEntries(resources.entries);
  resources.outputResource(binary);
  writeFileSync(file, Buffer.from(binary.generate()));
}

/** An .ico holding the PNG images as they are (Windows reads PNG icon images). */
function icoFromPngs(files) {
  const images = files.map((file) => readFileSync(file));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((png, i) => {
    const entry = 6 + 16 * i;
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    header.writeUInt8(width >= 256 ? 0 : width, entry);
    header.writeUInt8(height >= 256 ? 0 : height, entry + 1);
    header.writeUInt16LE(1, entry + 4); // color planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images]);
}

function fail(message) {
  console.error(`[sea] ${message}`);
  process.exit(1);
}
