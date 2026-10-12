// Launches an isolated VS Code instance (own user-data and extensions dirs) with this extension
// in development mode and runs test/e2e/suite.js inside its extension host.
// Usage: node test/e2e/run.mjs [path-to-Code-executable]
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..', '..');

function findCode() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.VSCODE_EXE) return process.env.VSCODE_EXE;
  const cli = execSync(process.platform === 'win32' ? 'where code' : 'which code', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  // .../bin/code(.cmd) -> .../Code.exe on Windows; on other platforms use the CLI directly.
  return process.platform === 'win32' ? path.join(path.dirname(path.dirname(cli)), 'Code.exe') : cli;
}

const code = findCode();
if (!existsSync(code)) throw new Error(`VS Code executable not found: ${code}`);

const sandbox = mkdtempSync(path.join(tmpdir(), 'orka-e2e-'));
const workspace = path.join(sandbox, 'workspace');
mkdirSync(workspace);
writeFileSync(path.join(workspace, 'README.md'), '# e2e workspace\n');
const report = path.join(sandbox, 'report.txt');

// Never run a real "claude update" from a test, and keep the UI language predictable.
mkdirSync(path.join(sandbox, 'user-data', 'User'), { recursive: true });
writeFileSync(
  path.join(sandbox, 'user-data', 'User', 'settings.json'),
  JSON.stringify({ 'orka.claudeCode.autoUpdate': false, 'orka.language': 'en' }, null, 2),
);

const env = { ...process.env, E2E_REPORT: report, E2E_USER_DATA: path.join(sandbox, 'user-data') };
delete env.ELECTRON_RUN_AS_NODE; // would turn Code.exe into plain Node

const args = [
  workspace,
  `--extensionDevelopmentPath=${extensionRoot}`,
  `--extensionTestsPath=${path.join(here, 'suite.js')}`,
  `--user-data-dir=${path.join(sandbox, 'user-data')}`,
  `--extensions-dir=${path.join(sandbox, 'extensions')}`,
  '--disable-extensions',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-gpu',
  '--new-window',
];

console.log(`Running e2e in ${sandbox}`);
const child = spawn(code, args, { env, stdio: 'inherit' });
const timeout = setTimeout(() => {
  console.error('e2e timed out');
  child.kill();
}, 180_000);
child.on('exit', (exitCode) => {
  clearTimeout(timeout);
  const text = existsSync(report) ? readFileSync(report, 'utf8') : '(no report written)';
  console.log(`\n--- e2e report ---\n${text}\n--- exit code ${exitCode} ---`);
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* VS Code may still hold files briefly */
  }
  process.exit(exitCode ?? 1);
});
