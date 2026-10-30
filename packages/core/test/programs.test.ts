import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { mergeText, ShadowGit } from '../src/changes/ShadowGit';
import { comspec, hardenProgramLookup, programPath, resolveCommand } from '../src/host/commands';
import { NodeHost } from '../src/host/NodeHost';
import { McpClient, serverCommand } from '../src/mcp/McpClient';
import { resolveClaudeExecutable } from '../src/providers/ClaudeCodeProvider';
import { runGit } from '../src/tools/GitTools';
import { tempWorkspace } from './helpers';

const WINDOWS = process.platform === 'win32';
const HAS_GIT = !!programPath('git');
const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const FAKE_MCP = path.resolve(__dirname, '../../test/fixtures/fake-mcp.mjs');

/** Change process.env for one test; undefined removes a variable. */
function setEnv(values: Record<string, string | undefined>): () => void {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (next: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  return () => apply(before);
}

describe('programs Orka starts itself', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => (ws = tempWorkspace()));
  afterEach(() => ws.cleanup());

  it('are found by their full path: on PATH (absolute entries only) or, for Windows, in its own folder', () => {
    if (HAS_GIT) assert.ok(path.isAbsolute(programPath('git')!));
    assert.equal(programPath('definitely-not-installed-xyz'), undefined, 'not found is not installed, never the bare name');
    assert.equal(programPath('C:\\Tools\\sh.exe', {}, 'win32'), 'C:\\Tools\\sh.exe', 'a path is taken as it is');
    // The tests run in a package folder, which has a package.json.
    assert.equal(programPath('package.json', { PATH: `.${path.delimiter}` }, 'linux'), undefined, 'a relative PATH entry is the current folder');
    // On Windows a program starts without a shell: a batch file on PATH is not one.
    writeFileSync(path.join(ws.root, 'tool.cmd'), '@echo off\r\n');
    assert.equal(programPath('tool', { PATH: ws.root }, 'win32'), undefined);
    writeFileSync(path.join(ws.root, 'tool.exe'), '');
    assert.equal(programPath('tool', { PATH: ws.root }, 'win32'), path.join(ws.root, 'tool.exe'));
    rmSync(path.join(ws.root, 'tool.exe'));
    assert.equal(programPath('tool', { PATH: ws.root }, 'win32'), undefined, 'an uninstalled program is not remembered');
    assert.equal(programPath('cmd.exe', { ComSpec: 'cmd.exe', SystemRoot: 'D:\\Win' }, 'win32'), 'D:\\Win\\System32\\cmd.exe');
    if (WINDOWS) {
      assert.equal(programPath('powershell.exe')?.toLowerCase(), path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase());
      assert.equal(programPath('cmd'), comspec());
      assert.equal(programPath('taskkill.exe')?.toLowerCase(), path.join(SYSTEM32, 'taskkill.exe').toLowerCase());
    }
  });

  it("Orka's own process is set up once so nothing it starts by name comes from the current folder (Windows)", () => {
    const env: NodeJS.ProcessEnv = {};
    hardenProgramLookup(env, 'win32');
    assert.equal(env.NoDefaultCurrentDirectoryInExePath, '1');
    const other: NodeJS.ProcessEnv = {};
    hardenProgramLookup(other, 'linux');
    assert.deepEqual(other, {});
  });

  it('a shell that is not installed is reported, not looked up in the workspace', async () => {
    const host = new NodeHost({ workspaceRoot: ws.root, shell: 'no-such-shell-xyz' });
    const result = await host.runCommand({ command: 'echo hi', cwd: ws.root, timeoutMs: 10_000, signal: new AbortController().signal });
    assert.equal(result.exitCode, null);
    assert.match(result.output, /The shell no-such-shell-xyz was not found/);
    assert.throws(() => host.startProcess({ name: 'dev', command: 'echo hi', cwd: ws.root }), /was not found/);
  });

  it('without git on PATH, git is "not installed" for the tools and the snapshots', async () => {
    const restore = setEnv({ PATH: ws.root });
    try {
      await assert.rejects(runGit(ws.root, ['status']), /git is not installed/);
      const shadow = new ShadowGit(ws.root, path.join(ws.root, 'shadow.git'));
      assert.equal(await shadow.snapshot(), undefined);
      assert.match(shadow.disabledReason ?? '', /not found on PATH/);
      assert.deepEqual(await mergeText('a\n', 'a\n', 'b\n'), { clean: false, text: '' });
    } finally {
      restore();
    }
  });
});

describe('a workspace that ships programs Orka starts (Windows)', { skip: !WINDOWS && 'Windows-only' }, () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let store: ReturnType<typeof tempWorkspace>;
  let restore: () => void;
  // Without Orka's own protection, as on a machine where nobody set it (CI, a user's).
  before(() => (restore = setEnv({ NoDefaultCurrentDirectoryInExePath: undefined })));
  after(() => restore());
  beforeEach(() => {
    ws = tempWorkspace();
    store = tempWorkspace();
    // Windows' hostname.exe stands in for a repository's own git.exe, powershell.exe or cmd.exe:
    // it fails for any argument, so the real program is easy to tell apart.
    for (const name of ['git.exe', 'powershell.exe', 'cmd.exe']) copyFileSync(path.join(SYSTEM32, 'hostname.exe'), path.join(ws.root, name));
    writeFileSync(path.join(ws.root, 'whoami.cmd'), '@echo PLANTED\r\n');
  });
  afterEach(() => {
    ws.cleanup();
    store.cleanup();
  });

  it("git for the tools, the context and the snapshots is never the repository's git.exe", { skip: !HAS_GIT && 'git is not installed' }, async () => {
    assert.match(await runGit(ws.root, ['--version']), /^git version/);
    writeFileSync(path.join(ws.root, 'a.txt'), 'one\n');
    const shadow = new ShadowGit(ws.root, path.join(store.root, 'shadow.git'));
    const id = await shadow.snapshot();
    assert.equal(shadow.disabledReason, undefined);
    assert.match(id ?? '', /^[0-9a-f]{40}$/);
    assert.deepEqual(await shadow.changedSince(id!), []);
  });

  it("the shell for commands (also an agent's terminal/create in a sub-folder) is never the workspace's powershell.exe", async () => {
    const tools = path.join(ws.root, 'tools');
    mkdirSync(tools);
    copyFileSync(path.join(SYSTEM32, 'hostname.exe'), path.join(tools, 'powershell.exe'));
    const host = new NodeHost({ workspaceRoot: ws.root });
    const run = (cwd: string) => host.runCommand({ command: 'Write-Output ok', cwd, timeoutMs: 60_000, signal: new AbortController().signal });
    for (const cwd of [ws.root, tools]) {
      const result = await run(cwd);
      assert.deepEqual([result.exitCode, result.output.trim()], [0, 'ok'], cwd);
    }
  });

  it("with cmd.exe as the shell, neither cmd.exe nor the programs a command names come from the workspace", async () => {
    const host = new NodeHost({ workspaceRoot: ws.root, shell: 'cmd.exe' });
    const result = await host.runCommand({ command: 'whoami', cwd: ws.root, timeoutMs: 60_000, signal: new AbortController().signal });
    assert.equal(result.exitCode, 0, result.output);
    assert.doesNotMatch(result.output, /PLANTED/);
    assert.ok(result.output.trim());
  });

  it("finds Claude Code on PATH only, not in the current folder (the CLI's project)", () => {
    // An empty home, and PATH with Windows' own programs only: no real Claude Code anywhere.
    writeFileSync(path.join(ws.root, 'claude.exe'), '');
    const cwd = process.cwd();
    const restoreEnv = setEnv({ PATH: SYSTEM32, USERPROFILE: store.root, APPDATA: store.root });
    process.chdir(ws.root);
    try {
      assert.equal(resolveClaudeExecutable(), '');
    } finally {
      process.chdir(cwd);
      restoreEnv();
    }
  });

  it('a bare program that is not on PATH is left to cmd.exe, whose environment keeps it out of the folder', () => {
    const { shell } = resolveCommand('definitely-missing-xyz.exe', [], 'win32', { PATH: store.root, SystemRoot: 'D:\\Win' });
    assert.equal(shell, 'D:\\Win\\System32\\cmd.exe', 'started directly, Node would look in the working folder first');
  });

  it("a server or agent behind a .cmd shim gets Windows' own cmd.exe, also without ComSpec", async () => {
    // A folder of its own, removed with retries: a stopped server lets go of it a moment later.
    const cwd = mkdtempSync(path.join(tmpdir(), 'orka-comspec-'));
    copyFileSync(path.join(SYSTEM32, 'hostname.exe'), path.join(cwd, 'cmd.exe'));
    const shim = path.join(cwd, 'server.cmd');
    writeFileSync(shim, `@"${process.execPath}" "${FAKE_MCP}" %*\r\n`);
    // With shell: true, Node would start a bare "cmd.exe": the one in the working folder.
    const restoreEnv = setEnv({ ComSpec: undefined });
    const client = new McpClient('shim', { command: shim, cwd });
    try {
      await client.start();
      assert.deepEqual(client.tools.map((tool) => tool.name), ['get_scene', 'delete_object']);
    } finally {
      client.close();
      restoreEnv();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("an MCP server started by bare name from its own configured folder still starts (that folder, by full path)", async () => {
    const dir = path.join(store.root, 'unity mcp');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'start-server.cmd'), `@"${process.execPath}" "${FAKE_MCP}" %*\r\n`);
    const config = { command: 'start-server.cmd', cwd: dir };
    assert.equal(serverCommand(config), path.join(dir, 'start-server.cmd'));
    assert.equal(serverCommand({ command: 'start-server.cmd' }), 'start-server.cmd', 'without a cwd of its own, nothing is looked up there');
    const client = new McpClient('unity', config);
    try {
      await client.start();
      assert.deepEqual(client.tools.map((tool) => tool.name), ['get_scene', 'delete_object']);
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
