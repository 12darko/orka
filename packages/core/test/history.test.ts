import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { DEFAULT_SUBAGENTS } from '../src/agents/subagents';
import { NodeHost } from '../src/host/NodeHost';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { FileTaskStore, newTaskId, type TaskSnapshot } from '../src/persistence/TaskStore';
import { PermissionManager } from '../src/permissions/PermissionManager';
import { createProvider, listModels } from '../src/providers';
import { call, ScriptedProvider, tempWorkspace, text } from './helpers';

describe('FileTaskStore', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => (ws = tempWorkspace()));
  afterEach(() => ws.cleanup());

  const snapshot = (id: string, title: string, updatedAt: string): TaskSnapshot => ({
    version: 1,
    id,
    title,
    createdAt: '2026-09-29T10:00:00Z',
    updatedAt,
    messages: [{ role: 'user', content: [{ type: 'text', text: '<context>\nx\n</context>\n\nhi' }] }],
    subagentProfiles: [],
    usageByAgent: [{ agent: 'main', provider: 'claude', model: 'claude-opus-5-5', calls: 2, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  });

  it('saves, lists newest first, loads and deletes tasks', async () => {
    const store = new FileTaskStore(path.join(ws.root, 'tasks'));
    await store.save(snapshot('a-1', 'First task', '2026-09-29T10:00:00Z'));
    await store.save(snapshot('b-2', 'Second task', '2026-09-29T11:00:00Z'));
    const list = await store.list();
    assert.deepEqual(list.map((t) => t.title), ['Second task', 'First task']);
    assert.equal(list[0].requests, 1);
    assert.equal(list[0].model, 'claude-opus-5-5');
    assert.equal(list[0].usage?.outputTokens, 5);
    assert.equal((await store.load('a-1'))?.title, 'First task');
    await store.delete('a-1');
    assert.deepEqual((await store.list()).map((t) => t.id), ['b-2']);
    assert.equal(await store.load('a-1'), undefined);
  });

  it('refuses ids that could escape the folder', async () => {
    const store = new FileTaskStore(path.join(ws.root, 'tasks'));
    await assert.rejects(store.save(snapshot('../evil', 'x', '2026-09-29T10:00:00Z')), /Invalid task id/);
    assert.equal(await store.load('../../etc/passwd'), undefined);
    assert.match(newTaskId(), /^[a-z0-9]+-[a-z0-9]+$/);
  });
});

describe('continuing a saved task', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => (ws = tempWorkspace()));
  afterEach(() => ws.cleanup());

  function orchestrator(main: ScriptedProvider, withSubagents: boolean) {
    return new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) }),
      getProvider: () => main,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 10, autoVerify: false, commandTimeoutMs: 30_000 }),
      subagents: { getProfiles: () => (withSubagents ? DEFAULT_SUBAGENTS : []), getProvider: () => main },
    });
  }

  it('restores the conversation, prompt and tools exactly, then extends them', async () => {
    const first = new ScriptedProvider([() => [call('write_file', { path: 'a.txt', content: 'one' })], () => [text('Wrote a.txt.')]]);
    const original = orchestrator(first, true);
    await original.run('create a.txt');
    const saved = JSON.parse(JSON.stringify(original.snapshot())); // as it would come back from disk

    // Later, in a new session where sub-agents are switched off in the settings.
    const second = new ScriptedProvider([
      (req) => {
        assert.equal(req.system, saved.systemPrompt, 'same frozen system prompt');
        assert.ok(req.tools.some((t) => t.name === 'run_subagent'), 'same tool list as when the task started');
        assert.deepEqual(req.messages.slice(0, saved.messages.length), saved.messages, 'history is a prefix');
        assert.match((req.messages.at(-1)!.content[0] as { text: string }).text, /now append two$/);
        return [text('Sure.')];
      },
    ]);
    const resumed = orchestrator(second, false);
    resumed.restore(saved);
    assert.equal(resumed.usageByAgent[0].calls, 2, 'usage carries over');
    assert.equal(await resumed.run('now append two'), 'completed');
    assert.equal(second.remaining, 0);
    assert.equal(resumed.usageByAgent[0].calls, 3);
  });
});

describe('custom OpenAI-compatible providers', () => {
  let server: Server;
  let url: string;
  const seen: string[] = [];
  before(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama-5-70b', object: 'model' }, { id: 'deepseek-coder', object: 'model' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'llama-5-70b', choices: [{ index: 0, delta: { content: 'hello from local' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  after(() => server.close());

  it('lists the endpoint models and chats without an API key (local servers)', async () => {
    assert.deepEqual(await listModels({ kind: 'custom', id: 'ollama', label: 'Ollama', baseURL: url }), ['deepseek-coder', 'llama-5-70b']);
    const provider = createProvider({ kind: 'custom', id: 'ollama', label: 'Ollama (local)', baseURL: url, model: 'llama-5-70b' });
    assert.equal(provider.id, 'custom:ollama');
    assert.equal(provider.label, 'Ollama (local)');
    const res = await provider.chat({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }, () => {});
    assert.deepEqual(res.message.content, [{ type: 'text', text: 'hello from local' }]);
    assert.ok(seen.some((s) => s.startsWith('POST /v1/chat/completions')));
  });

  it('sends the stored key for hosted endpoints', async () => {
    await listModels({ kind: 'custom', id: 'openrouter', label: 'OpenRouter', baseURL: url, apiKey: 'sk-or-test' });
    assert.ok(seen.some((s) => s === 'GET /v1/models Bearer sk-or-test'));
  });
});
