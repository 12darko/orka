import { setLocale } from '@orka/core';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { cmdLine, comspec, editorTerminal, shLine, terminalWindow } from '../src/terminal';

const WINDOWS = process.platform === 'win32';

/** The environment as it is without Orka's own protection (CI, a user's machine). */
function plainEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete env[key];
  return env;
}

describe('programs opened in a terminal', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orka-terminal-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => setLocale('en'));

  it('reach cmd.exe as one program with its arguments, also from a folder with spaces and parentheses', { skip: !WINDOWS }, () => {
    const folder = path.join(dir, 'Program Files (x86)', 'vendor');
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'agent.cmd');
    writeFileSync(file, '@echo ran %1 %2\r\n');
    // The planted program in the current folder must not run instead.
    writeFileSync(path.join(dir, 'agent.cmd'), '@echo planted\r\n');
    const run = spawnSync(comspec(), ['/d', '/s', '/c', cmdLine({ file, args: ['login', 'two words'] })], { cwd: dir, windowsVerbatimArguments: true, encoding: 'utf8' });
    assert.equal(run.stdout.trim(), 'ran "login" "two words"');
    // The desktop's form: a cmd.exe runs start, which starts the second one (/b: in this console, for the test).
    const started = spawnSync(comspec(), ['/d', '/c', `start "t" /b /wait "${comspec()}" /d /s /c ${cmdLine({ file, args: ['login', 'two words'] }, 'start')}`], {
      cwd: dir,
      windowsVerbatimArguments: true,
      encoding: 'utf8',
    });
    assert.equal(started.stdout.trim(), 'ran "login" "two words"');
  });

  it("in VS Code's terminal (one cmd.exe) take a path with & ! ^ and parentheses literally", { skip: !WINDOWS }, () => {
    const folder = path.join(dir, 'R&D !x^y (1)');
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'agent.cmd');
    writeFileSync(file, '@echo ran %1\r\n');
    const options = editorTerminal({ file, args: ['login'] }, plainEnv());
    assert.equal(options.strictEnv, true);
    assert.match(String(options.shellArgs), /^\/d \/v:off \/s \/k /);
    // The same line with /c, so cmd.exe exits; delayed expansion turned on would eat the "!".
    const args = String(options.shellArgs).replace(' /k ', ' /c ');
    const run = spawnSync(options.shellPath!, [args], { cwd: dir, env: options.env, windowsVerbatimArguments: true, encoding: 'utf8' });
    assert.equal(run.stdout.trim(), 'ran "login"', run.stderr);
    // The desktop's start form reads the path outside quotes: refused there, with what to type instead.
    assert.throws(() => terminalWindow('t', { file, args: ['login'] }), /Run this in a terminal yourself: ".*R&D !x\^y \(1\)\\agent\.cmd" login/);
    // When PATH finds that very program, by its name: a quoted path is no command in PowerShell.
    assert.throws(() => terminalWindow('t', { file, args: ['login'] }, { ...plainEnv(), PATH: folder, Path: folder }), /yourself: agent login$/);
  });

  it('refuse what cmd.exe would read as an operator or a variable, in words the user reads', () => {
    assert.throws(() => cmdLine({ file: 'C:\\a&b\\agent.cmd', args: [] }));
    assert.throws(() => cmdLine({ file: 'C:\\agent.cmd', args: ['%PATH%'] }));
    assert.throws(() => cmdLine({ file: 'C:\\agent.cmd', args: ['%PATH%'] }, 'direct'));
    assert.throws(() => cmdLine({ file: 'C:\\agent.cmd', args: ['a"b'] }, 'direct'));
    assert.equal(cmdLine({ file: 'C:\\R&D\\agent.exe', args: ['x!y'] }, 'direct'), '""C:\\R&D\\agent.exe" "x!y""');
    assert.equal(cmdLine({ file: 'C:\\x\\agent.exe', args: ['login'] }), '""C:\\x\\agent.exe" "login""');
    setLocale('tr');
    assert.throws(
      () => cmdLine({ file: 'C:\\Users\\R&D\\npm\\gemini.cmd', args: ['login'] }),
      (error: Error) => error.message.includes('kendiniz') && error.message.includes('"C:\\Users\\R&D\\npm\\gemini.cmd" login'),
    );
  });

  it("in the desktop app's window, neither cmd.exe runs a program from the folder (Install, hand-off)", { skip: !WINDOWS }, () => {
    const folder = path.join(dir, 'repo');
    mkdirSync(folder, { recursive: true });
    // A repository that ships whoami.cmd: "whoami" must still be Windows' own.
    writeFileSync(path.join(folder, 'whoami.cmd'), '@echo PLANTED\r\n');
    const { file, args, env } = terminalWindow('Freebuff', 'whoami', plainEnv());
    assert.equal(env.NoDefaultCurrentDirectoryInExePath, '1');
    // As the app starts it, but in this console (/b) and closing after the command (/c).
    const line = args[2].replace('/wait', '/b /wait').replace(' /k ', ' /c ');
    const run = spawnSync(file, [args[0], args[1], line], { cwd: folder, env, windowsVerbatimArguments: true, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.trim() && !run.stdout.includes('PLANTED'), run.stdout);
    // Without the environment, the inner cmd.exe would have run the repository's whoami.cmd.
    const unprotected = spawnSync(file, [args[0], args[1], line], { cwd: folder, env: plainEnv(), windowsVerbatimArguments: true, encoding: 'utf8' });
    assert.match(unprotected.stdout, /PLANTED/);
  });

  it("in VS Code, a program's terminal gets the user's environment only; a typed line keeps cmd.exe out of the folder", () => {
    const env = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', VSCODE_IPC_HOOK_EXTHOST: 'x', HOME: '/home/u' };
    const program = editorTerminal({ file: '/opt/agent', args: ['login'] }, env, 'linux');
    assert.equal(program.strictEnv, true);
    assert.deepEqual(program.env, { PATH: '/usr/bin', HOME: '/home/u' });
    assert.deepEqual(editorTerminal('freebuff', env, 'linux'), {});
    const win = editorTerminal({ file: 'C:\\x\\agent.exe', args: [] }, { Path: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, 'win32');
    assert.equal(win.strictEnv, true);
    assert.deepEqual(win.env, { Path: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', NoDefaultCurrentDirectoryInExePath: '1' });
    assert.equal(win.shellPath, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepEqual(editorTerminal('freebuff', env, 'win32'), { env: { NoDefaultCurrentDirectoryInExePath: '1' } });
  });

  it('reach a POSIX shell word for word', { skip: WINDOWS }, () => {
    const folder = path.join(dir, "it's here $HOME");
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'agent');
    writeFileSync(file, '#!/bin/sh\necho "ran $1|$2"\n');
    chmodSync(file, 0o755);
    const run = spawnSync('/bin/sh', ['-c', shLine({ file, args: ['login', "a 'b' $c"] })], { encoding: 'utf8' });
    assert.equal(run.stdout.trim(), "ran login|a 'b' $c");
  });

  it('use cmd.exe by its full path', () => {
    assert.equal(comspec({ ComSpec: 'cmd.exe', SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\cmd.exe');
    assert.equal(comspec({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' }), 'C:\\Windows\\system32\\cmd.exe');
  });
});
