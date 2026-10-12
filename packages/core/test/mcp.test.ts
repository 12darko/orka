import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { NodeHost } from '../src/host/NodeHost';
import { McpClient } from '../src/mcp/McpClient';
import { McpManager, mcpToolName } from '../src/mcp/McpManager';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import type { ToolContext } from '../src/tools/Tool';
import { call, ScriptedProvider, tempWorkspace, text } from './helpers';

const FAKE = { command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/fake-mcp.mjs')] };

describe('MCP', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let manager: McpManager;
  beforeEach(() => {
    ws = tempWorkspace();
    manager = new McpManager();
  });
  afterEach(() => {
    manager.dispose();
    ws.cleanup();
  });

  const ctx = (): ToolContext => {
    const host = new NodeHost({ workspaceRoot: ws.root });
    return { callId: 'c', host, changes: new ChangeTracker(host), signal: new AbortController().signal, commandTimeoutMs: 10_000, plan: undefined, setPlan: () => {}, onOutput: () => {} };
  };

  it('the client starts a stdio server, lists its tools and calls them', async () => {
    const client = new McpClient('unity', FAKE);
    try {
      await client.start();
      assert.equal(client.state, 'ready');
      assert.equal(client.serverName, 'fake-unity');
      assert.deepEqual(client.tools.map((tool) => tool.name), ['get_scene', 'delete_object']);
      const result = await client.callTool('get_scene', {}, new AbortController().signal, 5000);
      assert.deepEqual(result, { content: 'Main Camera\nPlayer\nEnemy', isError: false });
      const failed = await client.callTool('delete_object', { name: 'Ghost' }, new AbortController().signal, 5000);
      assert.deepEqual(failed, { content: 'No object named Ghost', isError: true });
    } finally {
      client.close();
    }
  });

  it('speaks Streamable HTTP too (JSON and event-stream answers, session id)', async () => {
    const seen: Array<{ method?: string; session?: string }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const msg = JSON.parse(raw);
        seen.push({ method: msg.method, session: req.headers['mcp-session-id'] as string | undefined });
        if (msg.id === undefined) return res.writeHead(202).end();
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-42' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'unity-http' } } }));
        }
        if (msg.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n\n`);
          return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'read_console', inputSchema: { type: 'object' } }] } })}\n\n`);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'No compile errors.' }] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = new McpClient('unity', { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` });
    try {
      await client.start();
      assert.equal(client.serverName, 'unity-http');
      assert.deepEqual(client.tools.map((tool) => tool.name), ['read_console']);
      assert.deepEqual(await client.callTool('read_console', {}, new AbortController().signal, 5000), { content: 'No compile errors.', isError: false });
      assert.equal(seen.find((s) => s.method === 'tools/call')?.session, 'sess-42', 'the session id is sent back');
    } finally {
      client.close();
      server.close();
    }
    const unreachable = new McpClient('down', { url: 'http://127.0.0.1:1/mcp' });
    await assert.rejects(unreachable.start(3000), /could not reach .* is the server running\?/);
  });

  it('tools become agent tools with permissions from the server hints', async () => {
    manager.sync({ unity: FAKE, broken: { command: path.join(ws.root, 'does-not-exist.exe') }, off: { ...FAKE, disabled: true } });
    const tools = await manager.tools();
    assert.deepEqual(tools.map((tool) => tool.name), ['mcp__unity__get_scene', 'mcp__unity__delete_object']);
    const [getScene, deleteObject] = tools;
    assert.equal(getScene.readOnly, true);
    const read = await getScene.describe({}, ctx());
    assert.deepEqual([read.category, read.risk], ['read', 'safe']);
    const del = await deleteObject.describe({ name: 'Enemy' }, ctx());
    assert.deepEqual([del.category, del.risk], ['command', 'dangerous'], 'destructive tools always ask');
    assert.deepEqual(await deleteObject.execute({ name: 'Enemy' }, ctx()), { content: 'Deleted Enemy', isError: false });
    const status = manager.status();
    assert.deepEqual(status.map((s) => [s.name, s.state, s.tools]), [
      ['unity', 'ready', 2],
      ['broken', 'error', 0],
      ['off', 'idle', 0],
    ]);
    assert.equal(mcpToolName('my server', 'do.it'), 'mcp__my_server__do_it');
  });

  it('the agent sees MCP tools for the whole task; read-only sub-agents only get read-only ones', async () => {
    manager.sync({ unity: FAKE });
    const sub = new ScriptedProvider([
      (req) => {
        const names = req.tools.map((tool) => tool.name);
        assert.ok(names.includes('mcp__unity__get_scene'));
        assert.ok(!names.includes('mcp__unity__delete_object'), 'no destructive MCP tools for explore');
        return [text('The scene has a Player.')];
      },
    ]);
    const main = new ScriptedProvider([
      (req) => {
        assert.ok(req.tools.some((tool) => tool.name === 'mcp__unity__delete_object'));
        assert.match(req.system, /# MCP servers[\s\S]*unity/);
        return [call('mcp__unity__get_scene', {}), call('run_subagent', { agent: 'explore', task: 'check the scene' })];
      },
      (req) => {
        const results = req.messages.at(-1)!.content.map((b) => (b.type === 'tool_result' ? b.content : ''));
        assert.equal(results[0], 'Main Camera\nPlayer\nEnemy');
        return [text('The scene has 3 objects.')];
      },
    ]);
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root }),
      getProvider: () => main,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 5, autoVerify: false, commandTimeoutMs: 10_000 }),
      subagents: { getProfiles: () => [{ name: 'explore', description: 'x', access: 'readonly' }], getProvider: () => sub },
      getExtraTools: () => manager.tools(),
    });
    assert.equal(await orchestrator.run('what is in the scene?'), 'completed');
    assert.equal(main.remaining, 0);
    assert.equal(sub.remaining, 0);
  });
});
