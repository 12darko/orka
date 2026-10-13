// Checks that every place that names Orka's version agrees with the root package.json:
//   node scripts/check-version.mjs           (CI: the files agree with each other)
//   node scripts/check-version.mjs v0.2.0    (Release: and with the pushed tag)
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));

const version = json('package.json').version;
const problems = [];
const expect = (where, actual) => {
  if (actual !== version) problems.push(`${where} says ${actual ?? 'nothing'}`);
};
const mention = (file, text) => {
  if (!read(file).includes(text)) problems.push(`${file} does not mention ${text}`);
};

const tag = process.argv[2];
if (tag && tag !== `v${version}`) problems.push(`the tag is ${tag}`);

const workspaces = json('package.json').workspaces;
for (const dir of workspaces) expect(`${dir}/package.json`, json(`${dir}/package.json`).version);

const lock = json('package-lock.json');
expect('package-lock.json', lock.version);
expect('package-lock.json (root package)', lock.packages['']?.version);
for (const dir of workspaces) expect(`package-lock.json (${dir})`, lock.packages[dir]?.version);

expect('packages/core/src/version.ts', /VERSION = '([^']+)'/.exec(read('packages/core/src/version.ts'))?.[1]);

const escaped = version.replaceAll('.', '\\.');
if (!new RegExp(`^## ${escaped}( |$)`, 'm').test(read('CHANGELOG.md'))) problems.push(`CHANGELOG.md has no "## ${version}" section`);
const cliUrl = `releases/download/v${version}/orka-agent-${version}.tgz`;
mention('README.md', `orka-vscode-${version}.vsix`);
mention('README.md', cliUrl);
mention('packages/cli/README.md', cliUrl);
// No README may still name the files or download folder of another version.
for (const file of ['README.md', 'packages/cli/README.md']) {
  for (const [name, found] of read(file).matchAll(/(?:orka-(?:agent|vscode)-|releases\/download\/v)(\d+\.\d+\.\d+[\w.-]*?)(?=\.tgz|\.vsix|\/)/g)) {
    if (found !== version) problems.push(`${file} still mentions ${name}`);
  }
}

if (problems.length) {
  console.error(`Version ${version} (package.json) does not match everywhere:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Version ${version} matches everywhere${tag ? ` and the tag ${tag}` : ''}.`);
