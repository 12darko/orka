import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { comspec } from '../src/host/commands';
import { resolveCommand } from '../src/mcp/McpClient';
import { tempWorkspace } from './helpers';

describe('Starting an MCP server through a Windows .cmd shim', { skip: process.platform !== 'win32' && 'Windows-only' }, () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => {
    ws = tempWorkspace();
    // Like npx.cmd / uvx.cmd: a batch file that passes its arguments on to a program.
    writeFileSync(path.join(ws.root, 'echo-args.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    writeFileSync(path.join(ws.root, 'echo args.cmd'), `@"${process.execPath}" "%~dp0echo-args.js" %*\r\n`);
  });
  afterEach(() => ws.cleanup());

  it('passes every argument through unchanged, and none can start another command', () => {
    const marker = path.join(ws.root, 'pwned.txt');
    const args = ['plain', 'with space', 'quote " inside', 'trailing\\', 'C:\\dir\\', 'a & b', 'x | y', '<in>', 'caret ^', '(paren)', `" & echo pwned > "${marker}`];
    const { file, args: quoted, shell } = resolveCommand(path.join(ws.root, 'echo args.cmd'), args, 'win32');
    assert.equal(shell, comspec());
    const result = spawnSync(file, quoted, { shell, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
    assert.ok(!require('node:fs').existsSync(marker), 'no injected command ran');
  });

  it('starts a program found on PATH (like uvx.exe) directly, without cmd.exe', () => {
    const { file, args, shell } = resolveCommand('node', ['--version', 'a b'], 'win32');
    assert.equal(shell, false);
    assert.match(file, /node\.exe$/i);
    assert.deepEqual(args, ['--version', 'a b']);
  });
});
