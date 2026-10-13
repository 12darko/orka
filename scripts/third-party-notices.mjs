// Writes THIRD_PARTY_NOTICES.txt for a bundle: the license and NOTICE texts of every npm package
// esbuild put into it, including code those packages vendor in subfolders. Builds pass their
// metafiles (esbuild option `metafile: true`); paths in a metafile are relative to the directory
// the build ran in.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([._-].*)?$/i;
// The last node_modules segment names the package (nested copies have their own).
const PACKAGE_DIR = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/;
// License texts for packages that ship none, kept in scripts/licenses/<name>.txt.
const KNOWN_LICENSES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'licenses');
const KNOWN = new Set(readdirSync(KNOWN_LICENSES).map((name) => name.replace(/\.txt$/, '')));

/**
 * @param {string} outFile
 * @param {string} product what the notices are for, e.g. "the Orka CLI"
 * @param {Array<import('esbuild').Metafile | undefined>} metafiles
 * @param {{ cwd?: string }} [options]
 */
export function writeThirdPartyNotices(outFile, product, metafiles, { cwd = process.cwd() } = {}) {
  const dirs = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile?.inputs ?? {})) {
      const match = PACKAGE_DIR.exec(input);
      if (match) dirs.add(path.resolve(cwd, match[1]));
    }
  }

  const sections = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    if (sections.has(key)) continue;
    const texts = licenseTexts(dir, pkg.name);
    if (!texts.length) {
      throw new Error(
        `${key} ships no license text. Add it as scripts/licenses/${pkg.name.replace('/', '__')}.txt (from the package's repository).`,
      );
    }
    const license = licenseOf(pkg);
    const lines = [`${pkg.name} ${pkg.version}${license ? ` (${license})` : ''}`];
    const home = repositoryOf(pkg);
    if (home) lines.push(home);
    lines.push('', texts.join('\n\n'));
    sections.set(key, lines.join('\n'));
  }

  const rule = '-'.repeat(79);
  const parts = [...sections.keys()].sort().map((key) => sections.get(key));
  const header =
    `Third-party software in ${product}\n\n` +
    'Orka is released under the MIT License (https://github.com/12darko/orka/blob/main/LICENSE). ' +
    `${product[0].toUpperCase()}${product.slice(1)} also contains the following software, under the licenses that follow.\n`;
  writeFileSync(outFile, [header, ...parts].join(`\n${rule}\n\n`) + '\n');
  return parts.length;
}

/**
 * The package's own license and NOTICE files, then those of code it vendors in subfolders (for
 * example a copy of qs inside an SDK). Without a file: the README's License section, or a text
 * from scripts/licenses.
 */
function licenseTexts(dir, name) {
  const seen = new Set();
  const texts = [];
  const add = (text, label) => {
    const trimmed = text.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    texts.push(label ? `${label}\n\n${trimmed}` : trimmed);
  };
  const files = licenseFiles(dir);
  for (const file of files) if (path.dirname(file) === dir) add(readFileSync(file, 'utf8'), '');
  if (!texts.length) for (const text of readmeLicense(dir)) add(text, '');
  if (!texts.length && KNOWN.has(name.replace('/', '__'))) {
    add(readFileSync(path.join(KNOWN_LICENSES, `${name.replace('/', '__')}.txt`), 'utf8'), '');
  }
  // Without a license of its own the build fails, even when code it vendors has one.
  if (!texts.length) return texts;
  for (const file of files) {
    if (path.dirname(file) === dir) continue;
    const relative = path.relative(dir, file).split(path.sep).join('/');
    add(readFileSync(file, 'utf8'), `Code in ${path.posix.dirname(relative)}/ (${relative}):`);
  }
  return texts;
}

/** License files in a package, its own first, never those of packages nested in it. */
function licenseFiles(dir) {
  const own = [];
  const vendored = [];
  const walk = (folder, depth) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(full, depth + 1);
      } else if (entry.isFile() && LICENSE_FILE.test(entry.name)) {
        (depth === 0 ? own : vendored).push(full);
      }
    }
  };
  walk(dir, 0);
  return [...own.sort(), ...vendored.sort()];
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return '';
}

function repositoryOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const url = (repo || pkg.homepage || '')
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^(https?:\/\/)[^@/]+@/, '$1')
    .replace(/^github:/, 'https://github.com/');
  // "owner/repo" is shorthand for a GitHub repository.
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

/** The "License" section of a package's README, if it has one. */
function readmeLicense(dir) {
  const readme = readdirSync(dir).find((name) => /^readme(\.|$)/i.test(name));
  if (!readme) return [];
  const lines = readFileSync(path.join(dir, readme), 'utf8').split(/\r?\n/);
  // Headings are "## License" or "License" underlined with --- or ===.
  const underline = (i) => /^[-=]{3,}\s*$/.test(lines[i + 1] ?? '') && lines[i].trim() !== '';
  const heading = (i) => /^#{1,6}\s/.test(lines[i]) || underline(i);
  const start = lines.findIndex((line, i) => heading(i) && /^(#{1,6}\s*)?licen[cs]e\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const body = start + (underline(start) ? 2 : 1);
  let end = body;
  while (end < lines.length && !heading(end)) end++;
  const text = lines.slice(body, end).join('\n').trim();
  return text ? [text] : [];
}
