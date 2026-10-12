import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_SUBAGENTS } from '../src/agents/subagents';
import { NodeHost } from '../src/host/NodeHost';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import { applyEvent, emptySession } from '../src/ui/transcript';
import { estimateCost } from '../src/usage/pricing';
import { call, ScriptedProvider, tempWorkspace, text } from './helpers';

describe('estimateCost', () => {
  const million = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  it('prices Claude API models from the list prices', () => {
    assert.deepEqual(estimateCost('claude', 'claude-opus-5-5', million), { kind: 'usd', usd: 4 });
    assert.deepEqual(estimateCost('claude', 'claude-haiku-4-5', { ...million, inputTokens: 0, outputTokens: 1_000_000 }), { kind: 'usd', usd: 5 });
    const cached = estimateCost('claude', 'claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 });
    assert.equal(cached.kind === 'usd' && cached.usd.toFixed(2), '0.20');
  });
  it('does not guess prices it does not know', () => {
    assert.deepEqual(estimateCost('claude-code', 'claude-haiku-4-5-20251001', million), { kind: 'subscription' });
    assert.deepEqual(estimateCost('openai', 'gpt-6-astra', million), { kind: 'unknown' });
    assert.deepEqual(estimateCost('claude', 'claude-unknown-9', million), { kind: 'unknown' });
  });
});

describe('usage per agent', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => (ws = tempWorkspace()));
  afterEach(() => ws.cleanup());

  it('splits tokens between the main agent, the supervisor and each sub-agent', async () => {
    const main = new ScriptedProvider([
      () => [call('run_subagent', { agent: 'explore', task: 'look around' })],
      () => [call('write_file', { path: 'a.txt', content: 'x' })],
      () => [text('done')],
    ]);
    const explore = new ScriptedProvider([() => [call('list_directory', {})], () => [text('empty project')]]);
    const supervisor = new ScriptedProvider(Array.from({ length: 5 }, () => () => [text('<verdict>ok</verdict>')]));
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) }),
      getProvider: () => main,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 10, autoVerify: false, commandTimeoutMs: 30_000 }),
      subagents: { getProfiles: () => DEFAULT_SUBAGENTS, getProvider: () => explore },
      supervisor: { getProvider: () => supervisor, getSettings: () => ({ enabled: true, frequency: 'on_changes', maxInterventions: 3 }) },
    });
    const session = emptySession();
    orchestrator.on((e) => applyEvent(session, e));
    await orchestrator.run('go');

    const byAgent = Object.fromEntries(orchestrator.usageByAgent.map((u) => [u.agent, u]));
    assert.deepEqual(Object.keys(byAgent), ['main', 'supervisor', 'explore']);
    assert.equal(byAgent.main.calls, 3);
    assert.equal(byAgent.explore.calls, 2);
    assert.equal(byAgent.supervisor.calls, supervisor.requests.length);
    assert.equal(byAgent.explore.model, 'scripted-model');
    const sum = orchestrator.usageByAgent.reduce((n, u) => n + u.usage.outputTokens, 0);
    assert.equal(orchestrator.totalUsage.outputTokens, sum);
    // The UI model carries the same breakdown, and the sub-agent card its own tokens.
    assert.deepEqual(session.usageByAgent?.map((u) => u.agent), ['main', 'supervisor', 'explore']);
    const delegate = session.items.find((i) => i.kind === 'tool' && i.call.name === 'run_subagent');
    assert.equal(delegate?.kind === 'tool' && delegate.sub?.usage?.outputTokens, 10);
  });
});
