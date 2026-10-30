import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AcpClient, type AcpLaunchSpec, type AcpSessionHandlers, safeEnv } from '../src/acp/AcpClient';
import { checkAgentCli, customAgentEntry, resolveAgentExecutable } from '../src/acp/catalog';
import { actionFor, commandOf } from '../src/acp/mapping';
import { AcpAgentPool } from '../src/acp/pool';
import { commandLine } from '../src/acp/terminals';
import type { SessionUpdate } from '../src/acp/types';
import { JsonRpcError, JsonRpcStdio } from '../src/rpc/JsonRpcStdio';
import { tempWorkspace } from './helpers';

const FAKE = path.resolve(__dirname, '../../test/fixtures/fake-acp.mjs');

describe('JSON-RPC over stdio', () => {
  /** A child running `script` (Node), speaking newline-delimited JSON on stdout. */
  const program = (script: string, options: ConstructorParameters<typeof JsonRpcStdio>[1] = { name: 'Test program' }) => {
    const rpc = new JsonRpcStdio({ command: process.execPath, args: ['-e', script], cwd: process.cwd() }, options);
    rpc.start();
    return rpc;
  };
  const ECHO = `
    let buf = '';
    const send = (m, eol = '\\n') => process.stdout.write(JSON.stringify(m) + eol);
    process.stdout.write('not json\\n');
    process.stdin.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.method === 'echo') send({ jsonrpc: '2.0', id: m.id, result: m.params }, '\\r\\n');
        if (m.method === 'fail') send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'needs login' } });
        if (m.method === 'ask') send({ jsonrpc: '2.0', id: 'q1', method: 'question', params: { n: 2 } });
        if (m.method === 'unknown') send({ jsonrpc: '2.0', id: 'q2', method: 'nope', params: {} });
        if (m.id === 'q1' || m.id === 'q2') send({ jsonrpc: '2.0', method: 'answered', params: m });
        if (m.method === 'exit') { process.stderr.write('bye from stderr\\n'); process.exit(3); }
      }
    });`;

  it('frames requests and answers, skips non-JSON lines and CRLF, answers the program\'s own requests', async () => {
    const notes: unknown[] = [];
    const rpc = program(ECHO, {
      name: 'Echo',
      onRequest: (method, params) => {
        if (method === 'question') return { answer: params.n * 21 };
        throw new JsonRpcError('no such thing', -32601);
      },
      onNotification: (method, params) => notes.push({ method, params }),
    });
    try {
      assert.deepEqual(await rpc.request('echo', { text: 'héllo\nworld' }, { timeoutMs: 5000 }), { text: 'héllo\nworld' });
      await assert.rejects(rpc.request('fail', {}, { timeoutMs: 5000 }), (e: unknown) => e instanceof JsonRpcError && e.code === -32000 && /needs login/.test(e.message));
      rpc.notify('ask', {});
      rpc.notify('unknown', {});
      await waitFor(() => notes.length >= 2);
      const answers = notes.map((n) => (n as { params: { id: string; result?: unknown; error?: { code: number } } }).params);
      assert.deepEqual(answers.find((a) => a.id === 'q1')?.result, { answer: 42 });
      assert.equal(answers.find((a) => a.id === 'q2')?.error?.code, -32601);
    } finally {
      rpc.close();
    }
  });

  it('times out, and fails pending calls with the stderr tail when the program exits', async () => {
    let closed = '';
    const rpc = program(ECHO, { name: 'Echo', onClose: (reason) => (closed = reason) });
    await assert.rejects(rpc.request('silence', {}, { timeoutMs: 200 }), /no answer to silence within/);
    const pending = rpc.request('never', {});
    rpc.notify('exit');
    await assert.rejects(pending, /Echo exited \(code 3\): bye from stderr/);
    assert.match(closed, /code 3/);
    assert.equal(rpc.running, false);
    await assert.rejects(rpc.request('echo', {}), /exited/, 'later calls fail at once');
  });

  it('reports a program that is not installed', async () => {
    const rpc = new JsonRpcStdio({ command: path.join(process.cwd(), 'no-such-agent.exe'), args: [], cwd: process.cwd() }, { name: 'Missing' });
    rpc.start();
    await assert.rejects(rpc.request('initialize', {}, { timeoutMs: 5000 }), /Missing (was not found|could not start|exited)/);
  });
});

describe('ACP client (fake agent)', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let log: string;
  const clients: AcpClient[] = [];
  beforeEach(() => {
    ws = tempWorkspace();
    log = path.join(ws.root, 'acp-log.jsonl');
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    ws.cleanup();
  });

  const spec = (script: unknown[], env: Record<string, string> = {}): AcpLaunchSpec => ({
    agentId: 'fake',
    label: 'Fake Agent',
    command: process.execPath,
    args: [FAKE],
    cwd: ws.root,
    env: { FAKE_ACP_SCRIPT: JSON.stringify(script), FAKE_ACP_LOG: log, ...env },
  });
  const client = (s: AcpLaunchSpec) => {
    const c = new AcpClient(s);
    clients.push(c);
    return c;
  };
  const logged = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

  it('does the handshake, opens a session, streams updates and routes the agent\'s requests', async () => {
    writeFileSync(path.join(ws.root, 'a.txt'), 'one\ntwo\nthree\n');
    const c = client(spec([[{ chunk: 'Reading. ' }, { readFile: { path: path.join(ws.root, 'a.txt'), line: 2, limit: 1 } }, { permission: { id: 'p1', kind: 'edit', title: 'Edit a.txt' } }, { stop: 'end_turn' }]]));
    const init = await c.start();
    assert.equal(init.agentInfo?.name, 'fake-acp', 'the log line before it and the CRLF did not matter');
    const first = logged().find((e) => e.event === 'initialize');
    assert.deepEqual(first.params.clientCapabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: true });
    assert.equal(first.params.protocolVersion, 1);

    const updates: SessionUpdate[] = [];
    const handlers = fakeHandlers({
      update: (u) => updates.push(u),
      readTextFile: async (p) => ({ content: readFileSync(p.path, 'utf8').split('\n').slice((p.line ?? 1) - 1, (p.line ?? 1) - 1 + (p.limit ?? 99)).join('\n') }),
      requestPermission: async (p) => ({ outcome: 'selected', optionId: p.options.find((o) => o.kind === 'allow_once')!.optionId }),
    });
    const sessionId = await c.newSession(ws.root, handlers);
    assert.equal(sessionId, 'sess-1');
    assert.equal(logged().find((e) => e.event === 'session/new').params.cwd, ws.root);
    assert.deepEqual(logged().find((e) => e.event === 'session/new').params.mcpServers, []);
    assert.equal(await c.prompt(sessionId, [{ type: 'text', text: 'hi' }]), 'end_turn');
    assert.ok(updates.some((u) => u.sessionUpdate === 'agent_message_chunk'));
    const events = logged();
    assert.deepEqual(events.find((e) => e.event === 'read_answer').result, { content: 'two' });
    assert.deepEqual(events.find((e) => e.event === 'permission_answer').outcome, { outcome: 'selected', optionId: 'yes' });
    assert.equal(events.find((e) => e.event === 'prompt').text, 'hi');
  });

  it('sends session/cancel when the prompt is aborted', async () => {
    const c = client(spec([[{ chunk: 'working' }, { hang: true }]]));
    const sessionId = await c.newSession(ws.root, fakeHandlers({}));
    const abort = new AbortController();
    const running = c.prompt(sessionId, [{ type: 'text', text: 'go' }], abort.signal);
    await waitFor(() => logged().some((e) => e.event === 'prompt'));
    abort.abort();
    assert.equal(await running, 'cancelled');
    assert.ok(logged().some((e) => e.event === 'session/cancel'));
  });

  it('surfaces "auth required" and only authenticates with methods the policy allows', async () => {
    const c = client(spec([], { FAKE_ACP_NEEDS_LOGIN: '1' }));
    await assert.rejects(c.newSession(ws.root, fakeHandlers({})), (e: unknown) => e instanceof JsonRpcError && e.code === -32000);
    await assert.rejects(c.authenticate('fake-login', []), /does not use the sign-in method/);
    await assert.rejects(c.authenticate('other', ['other']), /does not offer/);
    await c.authenticate('fake-login', ['fake-login']);
    assert.ok(logged().some((e) => e.event === 'authenticate'));
  });

  it('answers requests for unknown sessions and methods with errors', async () => {
    const c = client(spec([]));
    await c.start();
    const rpc = (c as unknown as { onRequest(method: string, params: unknown): Promise<unknown> }).onRequest.bind(c);
    await assert.rejects(rpc('fs/read_text_file', { sessionId: 'nope', path: 'x' }), (e: unknown) => e instanceof JsonRpcError && e.code === -32002);
    await assert.rejects(rpc('cursor/ask_question', { sessionId: 'nope' }), (e: unknown) => e instanceof JsonRpcError && e.code === -32601);
  });

  it('never passes credential-like environment variables to an agent', () => {
    assert.deepEqual(safeEnv({ FAKE_ACP_LOG: 'x', OPENAI_API_KEY: 'k', GH_TOKEN: 't', CLIENT_SECRET: 's', NODE_OPTIONS: '--x', MY_PASSWORD: 'p', GOOGLE_APPLICATION_CREDENTIALS: 'c' }), { FAKE_ACP_LOG: 'x', NODE_OPTIONS: '--x' });
  });

  it('pools processes per agent and folder, never stops a busy one, and stops idle ones', async () => {
    const pool = new AcpAgentPool({ max: 1, idleTimeoutMs: 100 });
    try {
      const a = await pool.acquire(spec([]));
      assert.equal(await pool.acquire(spec([])), a, 'same agent and folder: same process');
      await assert.rejects(pool.acquire({ ...spec([]), cwd: path.dirname(ws.root) }), /agent processes are already working/);
      pool.release(a);
      pool.release(a);
      const b = await pool.acquire({ ...spec([]), cwd: path.dirname(ws.root) });
      assert.notEqual(b, a, 'the idle process made room');
      assert.equal(a.alive, false);
      pool.release(b);
      await waitFor(() => !b.alive, 3000);
      assert.equal(pool.size, 0, 'idle processes stop after the timeout');
    } finally {
      pool.dispose();
    }
  });
});

describe('ACP helpers', () => {
  it('maps tool kinds to permission categories and command risk', () => {
    const root = path.resolve('/work/project');
    assert.deepEqual(pick(actionFor('read', {}, [path.join(root, 'a.ts')], root)), ['read', 'safe', false]);
    assert.deepEqual(pick(actionFor('edit', {}, [path.join(root, 'a.ts')], root)), ['edit', 'normal', false]);
    assert.deepEqual(pick(actionFor('edit', {}, [path.resolve(root, '../other/a.ts')], root)), ['edit', 'dangerous', true], 'outside the workspace always asks');
    assert.deepEqual(pick(actionFor('delete', {}, [], root)), ['delete', 'normal', false]);
    assert.deepEqual(pick(actionFor('execute', { command: 'npm test' }, [], root)), ['command', 'normal', false]);
    assert.deepEqual(pick(actionFor('execute', { command: ['bash', '-lc', 'rm -rf build'] }, [], root)), ['command', 'dangerous', false]);
    assert.deepEqual(pick(actionFor('execute', { command: 'git push origin main' }, [], root)), ['git', 'dangerous', false]);
    assert.deepEqual(pick(actionFor('fetch', { url: 'https://example.com' }, [], root)), ['network', 'normal', false]);
    assert.deepEqual(pick(actionFor('switch_mode', {}, [], root)), ['command', 'dangerous', true], 'a mode switch always asks');
    assert.equal(commandOf(['git', 'status']), 'git status');
    assert.equal(commandOf('ls'), 'ls');
    assert.equal(commandOf({ cmd: 'dir' }), 'dir');
  });

  it('quotes a command and its arguments for the host shell', () => {
    assert.equal(commandLine('npm test', [], 'powershell'), 'npm test', 'a whole shell line stays as it is');
    assert.equal(commandLine('C:\\Program Files\\node.exe', ['-e', "console.log('x y')"], 'powershell'), "& 'C:\\Program Files\\node.exe' -e 'console.log(''x y'')'");
    assert.equal(commandLine('node', ['--version'], 'pwsh'), 'node --version');
    assert.equal(commandLine('grep', ['-r', "it's here", 'src/'], 'bash'), "grep -r 'it'\\''s here' src/");
    assert.equal(commandLine('dir', ['a b'], 'cmd.exe'), 'dir "a b"');
  });

  it('checks an agent with its version flag only, and reports one that is missing', async () => {
    const node = { ...customAgentEntry({ name: 'Node', command: process.execPath }), versionArgs: ['--version'] };
    const ready = await checkAgentCli(node);
    assert.equal(ready.state, 'ready');
    assert.match(ready.version ?? '', /^\d+\.\d+/);
    assert.equal(ready.executable, path.resolve(process.execPath));
    assert.deepEqual(await checkAgentCli(customAgentEntry({ name: 'Ghost', command: 'definitely-not-installed-agent-xyz' })), { state: 'not_found' });
    assert.equal(resolveAgentExecutable(node, path.join(process.cwd(), 'missing', 'agent.exe')), undefined, "the user's path must exist");
    const custom = customAgentEntry({ name: 'My Agent!', command: 'my-agent', args: ['--acp'] });
    assert.deepEqual([custom.id, custom.policy, custom.acpArgs], ['custom:my-agent', 'custom', ['--acp']]);
  });
});

function pick(action: ReturnType<typeof actionFor>): [string, string, boolean] {
  return [action.category, action.risk, action.alwaysAsk];
}

function fakeHandlers(overrides: Partial<AcpSessionHandlers>): AcpSessionHandlers {
  return {
    update: () => {},
    requestPermission: async () => ({ outcome: 'cancelled' }),
    readTextFile: async () => ({ content: '' }),
    writeTextFile: async () => {},
    createTerminal: async () => ({ terminalId: 't' }),
    terminalOutput: () => ({ output: '', truncated: false }),
    waitForTerminalExit: async () => ({ exitCode: 0, signal: null }),
    killTerminal: () => {},
    releaseTerminal: () => {},
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
