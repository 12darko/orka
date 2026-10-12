import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { scanProject } from '../src/context/ProjectScanner';
import { NodeHost } from '../src/host/NodeHost';
import { applyEdit, editFileTool, listDirectoryTool, readFileTool, writeFileTool } from '../src/tools/FileTools';
import { searchCodeTool, searchFilesTool } from '../src/tools/SearchTools';
import { runCommandTool } from '../src/tools/TerminalTools';
import type { ToolContext } from '../src/tools/Tool';
import { validateInput } from '../src/tools/Tool';
import { globToRegExp, resolveInWorkspace } from '../src/tools/workspace';
import { tempWorkspace } from './helpers';

describe('applyEdit', () => {
  it('replaces a unique snippet', () => {
    assert.equal(applyEdit('a\nb\nc', { old_string: 'b', new_string: 'B' }).content, 'a\nB\nc');
  });
  it('rejects ambiguous matches unless replace_all', () => {
    assert.throws(() => applyEdit('x x', { old_string: 'x', new_string: 'y' }), /matches 2 places/);
    assert.deepEqual(applyEdit('x x', { old_string: 'x', new_string: 'y', replace_all: true }), { content: 'y y', count: 2 });
  });
  it('matches LF snippets against CRLF files and keeps CRLF', () => {
    const out = applyEdit('one\r\ntwo\r\nthree', { old_string: 'one\ntwo', new_string: 'ONE\nTWO' });
    assert.equal(out.content, 'ONE\r\nTWO\r\nthree');
  });
  it('explains a missing snippet', () => {
    assert.throws(() => applyEdit('abc', { old_string: 'zzz', new_string: 'y' }), /not found/);
  });
});

describe('globToRegExp', () => {
  it('matches bare names at any depth', () => {
    assert.ok(globToRegExp('*.cs').test('Assets/Scripts/Player.cs'));
    assert.ok(globToRegExp('PlayerController.cs').test('Assets/PlayerController.cs'));
    assert.ok(!globToRegExp('*.cs').test('Assets/Player.csproj'));
  });
  it('supports ** and braces', () => {
    const re = globToRegExp('src/**/*.{ts,tsx}');
    assert.ok(re.test('src/a.ts'));
    assert.ok(re.test('src/ui/deep/b.tsx'));
    assert.ok(!re.test('test/a.ts'));
  });
});

describe('validateInput', () => {
  const schema = readFileTool.inputSchema;
  it('accepts valid input', () => assert.equal(validateInput(schema, { path: 'a.ts', start_line: 3 }), undefined));
  it('rejects missing required fields', () => assert.match(validateInput(schema, {})!, /path is required/));
  it('rejects wrong types', () => assert.match(validateInput(schema, { path: 'a', start_line: 'x' })!, /integer/));
});

describe('resolveInWorkspace', () => {
  it('refuses paths outside the workspace', () => {
    const root = path.resolve('/tmp/ws');
    assert.throws(() => resolveInWorkspace(root, '../secret.txt'), /outside the workspace/);
    assert.throws(() => resolveInWorkspace(root, path.resolve('/etc/passwd')), /outside the workspace/);
    assert.equal(resolveInWorkspace(root, 'src/a.ts'), path.join(root, 'src', 'a.ts'));
  });
});

describe('file, search and terminal tools on a real folder', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let host: NodeHost;
  let ctx: ToolContext;

  before(() => {
    ws = tempWorkspace();
    mkdirSync(path.join(ws.root, 'src', 'net'), { recursive: true });
    mkdirSync(path.join(ws.root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(ws.root, 'src', 'net', 'LobbyManager.cs'), 'class LobbyManager {\r\n  void Join() {}\r\n}\r\n');
    writeFileSync(path.join(ws.root, 'src', 'Player.cs'), 'class Player { LobbyManager lobby; }\n');
    writeFileSync(path.join(ws.root, 'node_modules', 'dep', 'index.js'), 'LobbyManager inside dependency');
    writeFileSync(path.join(ws.root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' } }));
    host = new NodeHost({ workspaceRoot: ws.root });
    const changes = new ChangeTracker(host);
    ctx = {
      callId: 'test-call',
      host,
      changes,
      signal: new AbortController().signal,
      commandTimeoutMs: 30_000,
      plan: undefined,
      setPlan: () => {},
      onOutput: () => {},
    };
  });
  after(() => ws.cleanup());

  it('read_file numbers lines', async () => {
    const out = await readFileTool.execute({ path: 'src/net/LobbyManager.cs' }, ctx);
    assert.match(out.content, /1\| class LobbyManager \{/);
    assert.match(out.content, /lines 1-4 of 4/);
  });

  it('search_code finds matches and skips node_modules', async () => {
    const out = await searchCodeTool.execute({ query: 'lobbymanager' }, ctx);
    assert.match(out.content, /src\/net\/LobbyManager\.cs:1:/);
    assert.match(out.content, /src\/Player\.cs:1:/);
    assert.doesNotMatch(out.content, /node_modules/);
  });

  it('search_code honours glob and regex', async () => {
    const out = await searchCodeTool.execute({ query: 'void \\w+\\(', is_regex: true, glob: '*.cs' }, ctx);
    assert.match(out.content, /LobbyManager\.cs:2: void Join\(\) \{\}/);
  });

  it('search_files matches by glob', async () => {
    const out = await searchFilesTool.execute({ pattern: 'Lobby*.cs' }, ctx);
    assert.equal(out.content.trim(), 'src/net/LobbyManager.cs');
  });

  it('list_directory does not expand dependency folders', async () => {
    const out = await listDirectoryTool.execute({ depth: 3 }, ctx);
    assert.match(out.content, /node_modules\/ \(not expanded\)/);
    assert.match(out.content, /LobbyManager\.cs/);
  });

  it('edit_file keeps CRLF and records a revertable change', async () => {
    const file = path.join(ws.root, 'src', 'net', 'LobbyManager.cs');
    const before = readFileSync(file, 'utf8');
    await editFileTool.execute({ path: 'src/net/LobbyManager.cs', old_string: 'void Join() {}', new_string: 'public void Join() {}\n  public void Leave() {}' }, ctx);
    const edited = readFileSync(file, 'utf8');
    assert.match(edited, /public void Leave\(\) \{\}\r\n\}/);
    const changes = await ctx.changes.list();
    assert.deepEqual(changes.map((c) => [c.relPath, c.status]), [['src/net/LobbyManager.cs', 'modified']]);
    await ctx.changes.revert(changes[0].absPath);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal((await ctx.changes.list()).length, 0);
  });

  it('write_file creates files and revert deletes them again', async () => {
    await writeFileTool.execute({ path: 'src/ui/LobbyView.cs', content: 'class LobbyView {}\n' }, ctx);
    const file = path.join(ws.root, 'src', 'ui', 'LobbyView.cs');
    assert.ok(existsSync(file));
    const [change] = await ctx.changes.list();
    assert.equal(change.status, 'added');
    await ctx.changes.revertAll();
    assert.ok(!existsSync(file));
  });

  it('run_command returns output and exit code', async () => {
    const ok = await runCommandTool.execute({ command: 'node -e "console.log(21*2)"' }, ctx);
    assert.match(ok.content, /Exit code: 0/);
    assert.match(ok.content, /42/);
    assert.ok(!ok.isError);
    const bad = await runCommandTool.execute({ command: 'node -e "process.exit(3)"' }, ctx);
    assert.match(bad.content, /Exit code: 3/);
    assert.equal(bad.isError, true);
  });

  it('run_command times out long commands', async () => {
    const out = await runCommandTool.execute({ command: 'node -e "setTimeout(()=>{}, 20000)"', timeout_seconds: 1 }, ctx);
    assert.equal(out.isError, true);
    assert.match(out.content, /timed out after 1s/);
  });

  it('scanProject detects Node scripts', async () => {
    const info = await scanProject(host);
    assert.deepEqual(info.kinds, ['Node.js (npm)']);
    assert.deepEqual(info.verifyCommands, ['npm run build', 'npm test']);
    assert.match(info.fileTree, /src\//);
  });
});
