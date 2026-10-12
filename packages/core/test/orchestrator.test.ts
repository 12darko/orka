import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ApprovalRequest, ApprovalResponse } from '../src/host/Host';
import { NodeHost } from '../src/host/NodeHost';
import type { AgentEvent } from '../src/orchestrator/events';
import { Orchestrator, type OrchestratorSettings } from '../src/orchestrator/Orchestrator';
import { PermissionManager, type PermissionMode } from '../src/permissions/PermissionManager';
import { applyEvent, emptySession } from '../src/ui/transcript';
import { call, lastToolResults, ScriptedProvider, tempWorkspace, text } from './helpers';

const SETTINGS: OrchestratorSettings = { maxIterations: 20, autoVerify: true, commandTimeoutMs: 30_000 };

describe('Orchestrator agent loop', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let approvals: ApprovalRequest[];
  let answer: (req: ApprovalRequest) => Promise<ApprovalResponse>;

  beforeEach(() => {
    ws = tempWorkspace();
    mkdirSync(path.join(ws.root, 'src'));
    writeFileSync(path.join(ws.root, 'src', 'math.js'), 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n');
    writeFileSync(
      path.join(ws.root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "const {add}=require(\'./src/math.js\'); if (add(2,3)!==5) process.exit(1)"' } }),
    );
    approvals = [];
    answer = async () => ({ approved: true });
  });
  afterEach(() => ws.cleanup());

  function setup(provider: ScriptedProvider, mode: PermissionMode = 'balanced', settings = SETTINGS) {
    const host = new NodeHost({
      workspaceRoot: ws.root,
      approve: (req) => {
        approvals.push(req);
        return answer(req);
      },
    });
    const orchestrator = new Orchestrator({
      host,
      getProvider: () => provider,
      permissions: new PermissionManager(mode),
      getSettings: () => settings,
    });
    const events: AgentEvent[] = [];
    const session = emptySession();
    orchestrator.on((e) => {
      events.push(e);
      applyEvent(session, e);
    });
    return { orchestrator, events, session };
  }

  it('investigates, fixes, is nudged to verify, runs tests and completes', async () => {
    const provider = new ScriptedProvider([
      () => [text('I will look for the add function.'), call('search_code', { query: 'function add' })],
      (req) => {
        assert.match(lastToolResults(req)[0].content, /src\/math\.js:1:/);
        return [call('update_plan', { steps: [{ title: 'Fix add()', status: 'in_progress' }, { title: 'Run tests', status: 'pending' }] })];
      },
      () => [call('edit_file', { path: 'src/math.js', old_string: 'return a - b;', new_string: 'return a + b;' })],
      () => [text('Fixed the operator.')],
      (req) => {
        // The orchestrator appended a verification nudge as a new user turn.
        const last = req.messages[req.messages.length - 1];
        assert.equal(last.role, 'user');
        assert.match((last.content[0] as { text: string }).text, /Orchestrator check.*npm test/s);
        return [call('run_command', { command: 'npm test' })];
      },
      (req) => {
        assert.match(lastToolResults(req)[0].content, /Exit code: 0/);
        return [call('update_plan', { steps: [{ title: 'Fix add()', status: 'completed' }, { title: 'Run tests', status: 'completed' }] }), text('Done: add() fixed, tests pass.')];
      },
      () => [text('All steps complete.')],
    ]);
    const { orchestrator, events, session } = setup(provider);

    const reason = await orchestrator.run('add() returns wrong results, fix it', { activeFile: 'src/math.js' });

    assert.equal(reason, 'completed');
    assert.equal(provider.remaining, 0);
    assert.match(readFileSync(path.join(ws.root, 'src', 'math.js'), 'utf8'), /return a \+ b;/);
    assert.equal(approvals.length, 0, 'balanced mode needs no approvals here');
    assert.deepEqual(orchestrator.currentPlan?.steps.map((s) => s.status), ['completed', 'completed']);
    assert.deepEqual((await orchestrator.changes.list()).map((c) => c.relPath), ['src/math.js']);

    // First user turn carries the editor context block plus the request.
    const firstUser = provider.requests[0].messages[0];
    assert.match((firstUser.content[0] as { text: string }).text, /<context>[\s\S]*Active file: src\/math\.js[\s\S]*<\/context>\n\nadd\(\) returns/);

    // System prompt is frozen and every request extends the previous one (append-only history).
    for (let i = 1; i < provider.requests.length; i++) {
      assert.equal(provider.requests[i].system, provider.requests[0].system);
      const prev = provider.requests[i - 1].messages;
      assert.deepEqual(provider.requests[i].messages.slice(0, prev.length), prev, `request ${i} rewrote history`);
    }
    assert.match(provider.requests[0].system, /Node\.js \(npm\)/);

    const phases = events.filter((e) => e.type === 'phase').map((e) => (e as { phase: string }).phase);
    for (const p of ['analyzing', 'planning', 'implementing', 'verifying', 'idle']) assert.ok(phases.includes(p), `phase ${p}`);
    assert.equal(session.running, false);
    assert.ok(session.items.some((i) => i.kind === 'tool' && i.call.name === 'edit_file' && i.call.status === 'done'));
  });

  it('ask mode requests approval with a diff preview and relays a denial with feedback', async () => {
    answer = async () => ({ approved: false, feedback: 'Rename it to sum instead' });
    const provider = new ScriptedProvider([
      () => [call('edit_file', { path: 'src/math.js', old_string: 'return a - b;', new_string: 'return a + b;' })],
      (req) => {
        const [result] = lastToolResults(req);
        assert.equal(result.isError, true);
        assert.match(result.content, /declined.*Rename it to sum instead/);
        return [text('Understood.')];
      },
    ]);
    const { orchestrator, session } = setup(provider, 'ask');
    await orchestrator.run('fix add');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].category, 'edit');
    assert.match(approvals[0].preview!.after!, /return a \+ b;/);
    assert.match(readFileSync(path.join(ws.root, 'src', 'math.js'), 'utf8'), /return a - b;/, 'file untouched');
    const tool = session.items.find((i) => i.kind === 'tool');
    assert.equal(tool?.kind === 'tool' && tool.call.status, 'denied');
  });

  it('dangerous commands ask even in autonomous mode; "always allow" does not leak to other risks', async () => {
    const provider = new ScriptedProvider([
      () => [call('run_command', { command: 'git push origin main' })],
      () => [text('ok')],
    ]);
    answer = async () => ({ approved: false });
    const { orchestrator } = setup(provider, 'autonomous');
    await orchestrator.run('push it');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].risk, 'dangerous');
  });

  it('rejects invalid tool input and unknown tools without running anything', async () => {
    const provider = new ScriptedProvider([
      () => [call('write_file', { path: 'x.txt' }), call('teleport', {})],
      (req) => {
        const [bad, unknown] = lastToolResults(req);
        assert.match(bad.content, /content is required/);
        assert.match(unknown.content, /Unknown tool "teleport"/);
        return [text('Sorry.')];
      },
    ]);
    const { orchestrator } = setup(provider);
    await orchestrator.run('go');
    assert.equal(provider.remaining, 0);
  });

  it('never runs tool calls from a response cut off by max_tokens', async () => {
    const provider = new ScriptedProvider([
      () => ({
        message: { role: 'assistant', content: [call('write_file', { path: 'big.txt', content: 'partial' })] },
        stopReason: 'max_tokens',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'm',
      }),
      (req) => {
        assert.match(lastToolResults(req)[0].content, /output token limit/);
        return [text('Will split it.')];
      },
    ]);
    const { orchestrator } = setup(provider);
    await orchestrator.run('write a big file');
    assert.ok(!require('node:fs').existsSync(path.join(ws.root, 'big.txt')));
  });

  it('stop() during an approval cancels cleanly and leaves a valid history', async () => {
    let orchestratorRef: Orchestrator | undefined;
    answer = () => {
      setTimeout(() => orchestratorRef!.stop(), 10);
      return new Promise(() => {}); // user never answers
    };
    const provider = new ScriptedProvider([
      () => [call('delete_file', { path: 'src/math.js' })],
      () => [text('continuing after stop')],
    ]);
    const { orchestrator } = setup(provider, 'balanced');
    orchestratorRef = orchestrator;
    const reason = await orchestrator.run('delete it');
    assert.equal(reason, 'stopped');
    const history = orchestrator.history;
    const last = history[history.length - 1];
    assert.equal(last.role, 'user');
    assert.match((last.content[0] as { content: string }).content, /Cancelled/);
    // The next request continues the same conversation.
    const again = await orchestrator.run('never mind');
    assert.equal(again, 'completed');
  });

  it('pauses at the iteration limit', async () => {
    const provider = new ScriptedProvider(Array.from({ length: 3 }, () => () => [call('git_status', {})]));
    const { orchestrator, session } = setup(provider, 'balanced', { ...SETTINGS, maxIterations: 3 });
    const reason = await orchestrator.run('loop');
    assert.equal(reason, 'max_iterations');
    assert.ok(session.items.some((i) => i.kind === 'notice' && /Paused after 3 steps/.test(i.message)));
  });

  it('passes notes (e.g. user reverted a file) with the next user message', async () => {
    const provider = new ScriptedProvider([() => [text('noted')]]);
    const { orchestrator } = setup(provider);
    orchestrator.addNote('The user reverted your changes to src/math.js.');
    await orchestrator.run('hello');
    assert.match((provider.requests[0].messages[0].content[0] as { text: string }).text, /Note: The user reverted/);
  });
});
