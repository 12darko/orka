import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_SUBAGENTS } from '../src/agents/subagents';
import { NodeHost } from '../src/host/NodeHost';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import type { AIProvider } from '../src/providers/AIProvider';
import { applyEvent, emptySession } from '../src/ui/transcript';
import { call, lastToolResults, ScriptedProvider, tempWorkspace, text } from './helpers';

describe('sub-agents', () => {
  let ws: ReturnType<typeof tempWorkspace>;

  beforeEach(() => {
    ws = tempWorkspace();
    mkdirSync(path.join(ws.root, 'src'));
    writeFileSync(path.join(ws.root, 'src', 'math.js'), 'function add(a, b) {\n  return a - b;\n}\n');
  });
  afterEach(() => ws.cleanup());

  function setup(main: ScriptedProvider, subProviders: Record<string, AIProvider>) {
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) }),
      getProvider: () => main,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 20, autoVerify: false, commandTimeoutMs: 30_000 }),
      subagents: {
        getProfiles: () => DEFAULT_SUBAGENTS,
        getProvider: (name) => {
          const provider = subProviders[name];
          if (!provider) throw new Error(`no provider configured for ${name}`);
          return provider;
        },
      },
    });
    const session = emptySession();
    orchestrator.on((e) => applyEvent(session, e));
    return { orchestrator, session };
  }

  it('delegates to a read-only explore agent on its own provider and returns its report', async () => {
    const explore = new ScriptedProvider([
      (req) => {
        assert.match(req.system, /You are the "explore" sub-agent/);
        assert.match(req.system, /read-only tools/);
        assert.match((req.messages[0].content[0] as { text: string }).text, /Find where add\(\) is defined/);
        return [call('search_code', { query: 'function add' })];
      },
      () => [call('write_file', { path: 'hack.txt', content: 'x' })],
      (req) => {
        assert.match(lastToolResults(req)[0].content, /Unknown tool "write_file"/);
        return [text('add() is defined in src/math.js:1 and subtracts instead of adding.')];
      },
    ]);
    const main = new ScriptedProvider([
      (req) => {
        assert.match(req.system, /# Delegation/);
        assert.ok(req.tools.some((t) => t.name === 'run_subagent'));
        return [call('run_subagent', { agent: 'explore', task: 'Find where add() is defined and what it does.' })];
      },
      (req) => {
        const [result] = lastToolResults(req);
        assert.match(result.content, /^\[explore sub-agent report - Scripted scripted-model\]\nadd\(\) is defined in src\/math\.js:1/);
        return [text('Found it.')];
      },
    ]);
    const { orchestrator, session } = setup(main, { explore });

    assert.equal(await orchestrator.run('Where is add?'), 'completed');
    assert.equal(main.remaining, 0);
    assert.equal(explore.remaining, 0);
    assert.ok(!explore.requests[0].tools.includes('write_file') && !explore.requests[0].tools.includes('run_subagent'));
    assert.ok(!explore.requests[0].tools.includes('update_plan'));

    // The sub-agent's work is nested under the delegating tool call in the UI model.
    const delegate = session.items.find((i) => i.kind === 'tool' && i.call.name === 'run_subagent');
    assert.ok(delegate && delegate.kind === 'tool' && delegate.sub);
    assert.equal(delegate.sub!.agent, 'explore');
    assert.equal(delegate.sub!.running, false);
    assert.ok(delegate.sub!.items.some((i) => i.kind === 'tool' && i.call.name === 'search_code' && i.call.status === 'done'));
    assert.equal(delegate.call.status, 'done');
    // Usage from the sub-agent is added to the task total (2 main turns + 3 sub turns, 5 output tokens each).
    assert.equal(orchestrator.totalUsage.outputTokens, 25);
  });

  it('a worker sub-agent edits files into the shared change list', async () => {
    const worker = new ScriptedProvider([
      (req) => {
        assert.ok(req.tools.some((t) => t.name === 'edit_file'));
        return [call('edit_file', { path: 'src/math.js', old_string: 'return a - b;', new_string: 'return a + b;' })];
      },
      () => [text('Changed src/math.js line 2 to add.')],
    ]);
    const main = new ScriptedProvider([
      () => [call('run_subagent', { agent: 'worker', task: 'In src/math.js make add() return a + b.' })],
      () => [text('Done.')],
    ]);
    const { orchestrator, session } = setup(main, { worker });
    await orchestrator.run('fix add');
    assert.match(readFileSync(path.join(ws.root, 'src', 'math.js'), 'utf8'), /return a \+ b;/);
    assert.deepEqual((await orchestrator.changes.list()).map((c) => c.relPath), ['src/math.js']);
    assert.deepEqual(session.changes.map((c) => c.relPath), ['src/math.js'], 'parent publishes the shared change list');
  });

  it('reports an unavailable sub-agent provider back to the main agent', async () => {
    const main = new ScriptedProvider([
      () => [call('run_subagent', { agent: 'review', task: 'Review the diff.' })],
      (req) => {
        const [result] = lastToolResults(req);
        assert.equal(result.isError, true);
        assert.match(result.content, /Sub-agent "review" is not available: no provider configured for review/);
        return [text('I will review it myself.')];
      },
    ]);
    const { orchestrator } = setup(main, {});
    assert.equal(await orchestrator.run('review'), 'completed');
  });

  it('runs read-only sub-agents called together in parallel, workers one at a time, results in order', async () => {
    const timeline: string[] = [];
    let active = 0;
    let peak = 0;
    const slowAgent = (name: string, report: string) => ({
      id: 'slow',
      label: 'Slow',
      model: `slow-${name}`,
      chat: async () => {
        active++;
        peak = Math.max(peak, active);
        timeline.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 120));
        active--;
        timeline.push(`end ${name}`);
        return {
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: report }] },
          stopReason: 'end_turn' as const,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: `slow-${name}`,
        };
      },
    });
    const byTask: Record<string, ReturnType<typeof slowAgent>> = {};
    const router: AIProvider = {
      id: 'router',
      label: 'Router',
      model: 'router',
      chat: (req, onEvent) => {
        const task = (req.messages[0].content[0] as { text: string }).text;
        const name = /area (\w+)/.exec(task)?.[1] ?? 'x';
        byTask[name] ??= slowAgent(name, `report ${name}`);
        return byTask[name].chat();
      },
    };
    const main = new ScriptedProvider([
      () => [
        call('run_subagent', { agent: 'explore', task: 'Investigate area A' }),
        call('run_subagent', { agent: 'review', task: 'Investigate area B' }),
        call('run_subagent', { agent: 'explore', task: 'Investigate area C' }),
        call('run_subagent', { agent: 'worker', task: 'Change area D' }),
        call('run_subagent', { agent: 'worker', task: 'Change area E' }),
      ],
      (req) => {
        const results = lastToolResults(req).map((r) => r.content.split('\n')[1]);
        assert.deepEqual(results, ['report A', 'report B', 'report C', 'report D', 'report E'], 'results keep call order');
        return [text('ok')];
      },
    ]);
    const { orchestrator } = setup(main, { explore: router, review: router, worker: router });
    assert.equal(await orchestrator.run('split the work'), 'completed');
    // Measured by overlap, not wall-clock time, so a busy machine cannot fail it.
    assert.equal(peak, 3, 'the three read-only agents overlapped');
    const dStart = timeline.indexOf('start D');
    assert.ok(dStart > timeline.indexOf('end A') && dStart > timeline.indexOf('end C'), 'workers wait for the parallel group');
    assert.ok(timeline.indexOf('start E') > timeline.indexOf('end D'), 'workers never overlap');
  });

  it('stopping the main agent stops a running sub-agent', async () => {
    let orchestratorRef: Orchestrator | undefined;
    const slow: AIProvider = {
      id: 'slow',
      label: 'Slow',
      model: 'slow-1',
      chat: (request) =>
        new Promise((_, reject) => {
          setTimeout(() => orchestratorRef!.stop(), 10);
          request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
        }),
    };
    const main = new ScriptedProvider([() => [call('run_subagent', { agent: 'explore', task: 'look around' })]]);
    const { orchestrator, session } = setup(main, { explore: slow });
    orchestratorRef = orchestrator;
    assert.equal(await orchestrator.run('go'), 'stopped');
    const delegate = session.items.find((i) => i.kind === 'tool' && i.call.name === 'run_subagent');
    assert.ok(delegate && delegate.kind === 'tool' && delegate.sub && !delegate.sub.running);
  });
});
