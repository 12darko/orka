import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { cmdLine, comspec, shLine } from '../src/terminal';

describe('programs opened in a terminal', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orka-terminal-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('reach cmd.exe as one program with its arguments, also from a folder with spaces and parentheses', { skip: process.platform !== 'win32' }, () => {
    const folder = path.join(dir, 'Program Files (x86)', 'vendor');
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'agent.cmd');
    writeFileSync(file, '@echo ran %1 %2\r\n');
    // The planted program in the current folder must not run instead.
    writeFileSync(path.join(dir, 'agent.cmd'), '@echo planted\r\n');
    const run = spawnSync(comspec(), ['/d', '/s', '/c', cmdLine({ file, args: ['login', 'two words'] })], { cwd: dir, windowsVerbatimArguments: true, encoding: 'utf8' });
    assert.equal(run.stdout.trim(), 'ran "login" "two words"');
  });

  it('refuses what cmd.exe would read as an operator or a variable', () => {
    assert.throws(() => cmdLine({ file: 'C:\\a&b\\agent.cmd', args: [] }));
    assert.throws(() => cmdLine({ file: 'C:\\agent.cmd', args: ['%PATH%'] }));
    assert.equal(cmdLine({ file: 'C:\\x\\agent.exe', args: ['login'] }), '""C:\\x\\agent.exe" "login""');
  });

  it('reach a POSIX shell word for word', { skip: process.platform === 'win32' }, () => {
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
