import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AcpLaunchSpec } from '../src/acp/AcpClient';
import { AcpAgentPool, pooledAgent } from '../src/acp/pool';
import { ShadowGit } from '../src/changes/ShadowGit';
import type { ApprovalRequest, ApprovalResponse } from '../src/host/Host';
import { NodeHost } from '../src/host/NodeHost';
import type { AgentEvent } from '../src/orchestrator/events';
import { Orchestrator, type OrchestratorSettings } from '../src/orchestrator/Orchestrator';
import { type PermissionMode, PermissionManager } from '../src/permissions/PermissionManager';
import type { SupervisorSettings } from '../src/supervisor/Supervisor';
import { applyEvent, emptySession } from '../src/ui/transcript';
import { ScriptedProvider, tempWorkspace, text } from './helpers';

const FAKE = path.resolve(__dirname, '../../test/fixtures/fake-acp.mjs');
const SETTINGS: OrchestratorSettings = { maxIterations: 10, autoVerify: false, commandTimeoutMs: 30_000 };
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const OK = '<verdict>ok</verdict>';

type Step = Record<string, unknown>;

describe('a third-party agent over ACP as the main agent', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let store: ReturnType<typeof tempWorkspace>;
  let pool: AcpAgentPool;
  let log: string;
  const file = (name: string) => path.join(ws.root, name);
  const read = (name: string) => readFileSync(file(name), 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form log lines of the fake agent
  const logged = (): any[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

  beforeEach(() => {
    ws = tempWorkspace();
    store = tempWorkspace();
    pool = new AcpAgentPool();
    // Outside the workspace, so the snapshots never see it.
    log = path.join(store.root, 'acp-log.jsonl');
    writeFileSync(file('a.txt'), 'a0\n');
  });
  afterEach(() => {
    pool.dispose();
    ws.cleanup();
    store.cleanup();
  });

  function setup(
    turns: Step[][],
    options: {
      mode?: PermissionMode;
      approve?: (request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>;
      snapshots?: boolean;
      supervisor?: { provider: ScriptedProvider; settings?: Partial<SupervisorSettings> };
      settings?: Partial<OrchestratorSettings>;
      env?: Record<string, string>;
      /** The main agent is the fake agent while this says so, else `model`. */
      useAgent?: () => boolean;
      model?: ScriptedProvider;
    } = {},
  ) {
    const approvals: ApprovalRequest[] = [];
    const host = new NodeHost({
      workspaceRoot: ws.root,
      approve: async (request) => {
        approvals.push(request);
        return options.approve ? options.approve(request) : { approved: true };
      },
    });
    const spec: AcpLaunchSpec = {
      agentId: 'fake',
      label: 'Fake Agent',
      command: process.execPath,
      args: [FAKE],
      cwd: ws.root,
      env: { FAKE_ACP_SCRIPT: JSON.stringify(turns), FAKE_ACP_LOG: log, ...(options.env ?? {}) },
      loginCommand: 'fake login',
    };
    const events: AgentEvent[] = [];
    const orchestrator = new Orchestrator({
      host,
      getProvider: () => {
        if (options.model) return options.model;
        throw new Error('the main agent is the external agent: no model is asked');
      },
      permissions: new PermissionManager(options.mode ?? 'balanced'),
      getSettings: () => ({ ...SETTINGS, ...options.settings }),
      commandSnapshots: options.snapshots === false ? undefined : new ShadowGit(ws.root, path.join(store.root, 'shadow.git')),
      getExternalAgent: () => ((options.useAgent?.() ?? true) ? pooledAgent(pool, spec) : undefined),
      supervisor: options.supervisor && {
        getProvider: () => options.supervisor!.provider,
        getSettings: () => ({ enabled: true, frequency: 'final_only', maxInterventions: 3, ...options.supervisor!.settings }),
      },
    });
    const session = emptySession();
    orchestrator.on((event) => {
      events.push(event);
      applyEvent(session, event);
    });
    return { orchestrator, session, approvals, events };
  }

  const gitIt = (name: string, fn: () => Promise<void>) => it(name, { skip: !HAS_GIT && 'git is not installed' }, fn);

  gitIt('shows the answer, reasoning, tool calls and plan in the transcript; the history stays plain text', async () => {
    const { orchestrator, session } = setup([
      [
        { thought: 'Look at a.txt first.' },
        { chunk: 'Let me look. ' },
        { toolCall: { id: 't1', title: 'Read a.txt', kind: 'read', locations: [{ path: file('a.txt') }] } },
        { readFile: { path: file('a.txt') } },
        { toolCallUpdate: { id: 't1', status: 'completed', text: 'a0' } },
        { plan: [{ content: 'Read the file', status: 'completed' }, { content: 'Explain it', status: 'in_progress' }] },
        { chunk: 'It holds a0.' },
      ],
    ]);
    assert.equal(await orchestrator.run('what is in a.txt?'), 'completed');
    const kinds = session.items.map((i) => (i.kind === 'tool' ? `tool:${i.call.name}:${i.call.status}` : i.kind));
    assert.deepEqual(kinds, ['user', 'assistant', 'tool:acp:read:done', 'assistant']);
    const [, first, tool, last] = session.items;
    assert.ok(first.kind === 'assistant' && first.text === 'Let me look. ' && first.reasoning === 'Look at a.txt first.');
    assert.ok(last.kind === 'assistant' && last.text === 'It holds a0.' && last.model === 'Fake Agent');
    assert.ok(tool.kind === 'tool' && tool.call.output === 'a0' && tool.call.category === 'read' && tool.call.path === file('a.txt'));
    assert.match(tool.id, /^acp_sess-1_1_.+_t1$/, 'card ids carry the ACP session and the turn');
    assert.deepEqual(orchestrator.currentPlan?.steps.map((s) => s.status), ['completed', 'in_progress']);
    assert.deepEqual(logged().find((e) => e.event === 'read_answer').result, { content: 'a0\n' });
    // The history: the request (with Orka's context block) and the answer as plain text.
    const history = orchestrator.history;
    assert.deepEqual(history.map((m) => m.role), ['user', 'assistant']);
    assert.ok(history.every((m) => m.content.every((b) => b.type === 'text')), 'no tool blocks');
    const answer = history[1].content[0];
    assert.ok(answer.type === 'text' && answer.text.startsWith('Let me look. \n\nIt holds a0.') && /<agent_activity agent="Fake Agent">\n- read: Read a\.txt -> ok/.test(answer.text));
    assert.match(logged().find((e) => e.event === 'prompt').text, /^<context>[\s\S]*<\/context>\n\nwhat is in a\.txt\?$/);
    const usage = orchestrator.usageByAgent[0];
    assert.deepEqual([usage.agent, usage.provider, usage.model, usage.calls, usage.unreported], ['main', 'agent:fake', 'Fake Agent', 1, true]);
  });

  gitIt('answers permission requests with Orka\'s rules, always "once", and passes declines on', async () => {
    const execute = (id: string, command: string) => ({ permission: { id, kind: 'execute', title: command, rawInput: { command } } });
    const { orchestrator, approvals } = setup(
      [
        [execute('p1', 'npm test'), execute('p2', 'rm -rf build'), { permission: { id: 'p3', kind: 'switch_mode', title: 'Switch to auto-approve' } }],
        [{ chunk: 'ok' }],
      ],
      { approve: (r) => (r.title === 'rm -rf build' ? { approved: false, feedback: 'not now' } : { approved: true, alwaysAllow: true }) },
    );
    assert.equal(await orchestrator.run('test it'), 'completed');
    const answers = logged().filter((e) => e.event === 'permission_answer').map((e) => [e.id, e.outcome.optionId]);
    assert.deepEqual(answers, [['p1', 'yes'], ['p2', 'no'], ['p3', 'yes']], 'never "always": the decision stays with Orka');
    assert.deepEqual(approvals.map((a) => a.title), ['rm -rf build', 'Switch to auto-approve'], 'a normal command runs in balanced mode; a dangerous one and a mode switch ask');
    assert.equal(approvals[0].risk, 'dangerous');
    // What the user said when declining reaches the agent with its next prompt.
    await orchestrator.run('next');
    assert.match(logged().filter((e) => e.event === 'prompt')[1].text, /^\[Orka\] Notes from your previous turn:\n- The user declined "rm -rf build"\. User feedback: not now/);
  });

  gitIt('in ask mode, "always allow" becomes Orka\'s own session grant', async () => {
    const edit = (id: string) => ({ permission: { id, kind: 'edit', title: `Edit ${id}`, locations: [{ path: file('a.txt') }] } });
    const { orchestrator, approvals } = setup([[edit('e1'), edit('e2')]], { mode: 'ask', approve: () => ({ approved: true, alwaysAllow: true }) });
    assert.equal(await orchestrator.run('edit twice'), 'completed');
    assert.equal(approvals.length, 1, 'the second edit is covered by the grant');
    assert.deepEqual(logged().filter((e) => e.event === 'permission_answer').map((e) => e.outcome.optionId), ['yes', 'yes']);
  });

  gitIt('writes through fs/write_text_file land in Changes and can be reverted; paths outside are refused', async () => {
    const outside = path.join(store.root, 'outside.txt');
    const { orchestrator, approvals, session } = setup([[{ writeFile: { path: file('a.txt'), content: 'a1\n' } }, { writeFile: { path: file('src/new.ts'), content: 'export {};\n' } }, { writeFile: { path: outside, content: 'x' } }]]);
    assert.equal(await orchestrator.run('change a'), 'completed');
    assert.equal(read('a.txt'), 'a1\n');
    assert.equal(approvals.length, 0, 'edits run without asking in balanced mode');
    assert.equal(existsSync(outside), false);
    assert.match(logged().filter((e) => e.event === 'write_answer')[2].error.message, /only lets agents use files inside the workspace/);
    assert.deepEqual((await orchestrator.changes.list()).map((c) => `${c.relPath} ${c.status}`), ['a.txt modified', 'src/new.ts added']);
    assert.ok(session.items.some((i) => i.kind === 'tool' && i.call.name === 'acp:write' && i.call.status === 'done'));
    await orchestrator.changes.revertAll();
    assert.equal(read('a.txt'), 'a0\n');
    assert.equal(existsSync(file('src/new.ts')), false);
  });

  gitIt('an approved diff covers that exact write only', async () => {
    const { orchestrator, approvals } = setup(
      [
        [
          { permission: { id: 'e1', kind: 'edit', title: 'Edit a.txt', locations: [{ path: file('a.txt') }], diff: { path: file('a.txt'), oldText: 'a0\n', newText: 'a1\n' } } },
          { writeFile: { path: file('a.txt'), content: 'a1\n' } },
          { writeFile: { path: file('a.txt'), content: 'something else\n' } },
        ],
      ],
      { mode: 'ask' },
    );
    assert.equal(await orchestrator.run('change a'), 'completed');
    assert.deepEqual(approvals.map((a) => [a.toolName, a.preview?.after]), [
      ['acp:edit', 'a1\n'],
      ['acp:write', 'something else\n'],
    ]);
  });

  gitIt('files the agent writes with its own tools are caught by the snapshot and revertible', async () => {
    const { orchestrator } = setup([[{ directWrite: { path: 'gen/out.ts', content: 'generated\n' } }, { directWrite: { path: 'a.txt', content: 'changed by the agent\n' } }, { chunk: 'Generated.' }]]);
    assert.equal(await orchestrator.run('generate'), 'completed');
    assert.deepEqual((await orchestrator.changes.list()).map((c) => `${c.relPath} ${c.status}`), ['a.txt modified', 'gen/out.ts added']);
    const answer = orchestrator.history[1].content[0];
    assert.ok(answer.type === 'text' && /- files changed: (a\.txt \(modified\), gen\/out\.ts \(added\)|gen\/out\.ts \(added\), a\.txt \(modified\))/.test(answer.text));
    await orchestrator.changes.revertAll();
    assert.equal(read('a.txt'), 'a0\n');
    assert.equal(existsSync(file('gen/out.ts')), false);
  });

  it('refuses to start without snapshots, before anything runs or is recorded', async () => {
    const { orchestrator, session } = setup([[{ chunk: 'should not run' }]], { snapshots: false });
    assert.equal(await orchestrator.run('do it'), 'error');
    const notice = session.items.find((i) => i.kind === 'notice');
    assert.ok(notice && notice.kind === 'notice' && notice.level === 'error' && /Fake Agent cannot start: turn on "Make command changes revertible"/.test(notice.message));
    assert.equal(existsSync(log), false, 'the agent was never started');
    assert.equal(orchestrator.history.length, 0);
  });

  gitIt('after a rewind the next request starts a fresh session with a brief', async () => {
    const { orchestrator, events } = setup([
      [{ chunk: 'one' }],
      [{ toolCall: { id: 't1', title: 'Edit a', kind: 'edit' } }, { writeFile: { path: file('a.txt'), content: 'a2\n' } }, { toolCallUpdate: { id: 't1', status: 'completed' } }],
      [{ toolCall: { id: 't1', title: 'Edit a again', kind: 'edit' } }, { toolCallUpdate: { id: 't1', status: 'completed' } }],
    ]);
    await orchestrator.run('first request');
    await orchestrator.run('second request');
    assert.equal(read('a.txt'), 'a2\n');
    const second = orchestrator.rewindTargets[1];
    await orchestrator.rewind(second.id);
    assert.equal(read('a.txt'), 'a0\n', 'files are restored');
    await orchestrator.run('second request, differently');
    const news = logged().filter((e) => e.event === 'session/new');
    assert.equal(news.length, 2);
    const prompts = logged().filter((e) => e.event === 'prompt');
    assert.deepEqual(prompts.map((p) => p.sessionId), ['sess-1', 'sess-1', 'sess-2']);
    assert.match(prompts[2].text, /^\[Orka\] You are taking over a task that is already under way[\s\S]*Task:\nfirst request[\s\S]*# New request\n<context>[\s\S]*second request, differently$/);
    const ids = events.flatMap((e) => (e.type === 'tool_call' && e.call.name === 'acp:edit' ? [e.call.id] : []));
    const unique = [...new Set(ids)];
    assert.equal(unique.length, 2, 'the same tool call id in a fresh session gets a new card');
    assert.match(unique[1], /^acp_sess-2_1_/);
  });

  gitIt('a task can move from the agent to an API model and back', async () => {
    let agent = true;
    const model = new ScriptedProvider([
      (req) => {
        // The agent's turns are plain text: valid history for any provider.
        assert.ok(req.messages.every((m) => m.content.every((b) => b.type === 'text')));
        assert.match((req.messages[1].content[0] as { text: string }).text, /^From the agent\./);
        return [text('From the model.')];
      },
    ]);
    const { orchestrator, session } = setup([[{ chunk: 'From the agent.' }], [{ chunk: 'Agent again.' }]], { useAgent: () => agent, model });
    assert.equal(await orchestrator.run('first'), 'completed');
    agent = false;
    assert.equal(await orchestrator.run('second'), 'completed');
    agent = true;
    assert.equal(await orchestrator.run('third'), 'completed');
    const prompts = logged().filter((e) => e.event === 'prompt');
    assert.deepEqual(prompts.map((p) => p.sessionId), ['sess-1', 'sess-2'], 'the agent missed the model\'s turn: a fresh session');
    assert.match(prompts[1].text, /Task \(the user's requests, oldest first\):\n- first\n- second[\s\S]*# New request\n<context>[\s\S]*third$/);
    const notices = session.items.flatMap((i) => (i.kind === 'notice' ? [i.message] : []));
    assert.deepEqual(notices, ['The main agent now runs on Scripted · scripted-model. It continues this task with the same conversation.', 'Fake Agent takes over as the main agent, with a summary of this task so far.']);
  });

  gitIt('the Supervisor\'s final review can send the agent back with a correction', async () => {
    const supervisor = new ScriptedProvider([() => [text('<verdict>intervene</verdict>\n<message>Add a test for it.</message>')], () => [text(OK)]]);
    const { orchestrator, session } = setup([[{ chunk: 'Done.' }], [{ chunk: 'Added the test.' }]], { supervisor: { provider: supervisor, settings: { frequency: 'checkpoints' } } });
    assert.equal(await orchestrator.run('fix it'), 'completed');
    const prompts = logged().filter((e) => e.event === 'prompt');
    assert.equal(prompts.length, 2);
    assert.match(prompts[1].text, /^\[Supervisor\] Add a test for it\./);
    const reviews = session.items.filter((i) => i.kind === 'supervisor').map((i) => i.kind === 'supervisor' && [i.scope, i.status]);
    assert.deepEqual(reviews, [
      ['final', 'intervened'],
      ['final', 'ok'],
    ]);
    const notices = session.items.filter((i) => i.kind === 'notice' && /reviews only the final result/.test(i.message));
    assert.equal(notices.length, 1, 'other Supervisor modes fall back to the final review, said once');
    assert.equal(supervisor.remaining, 0);
  });

  gitIt('runs approved terminal commands in the workspace and shows their output', async () => {
    const { orchestrator, session } = setup([[{ terminal: { command: process.execPath, args: ['-e', 'console.log(6*7)'] } }]]);
    assert.equal(await orchestrator.run('compute'), 'completed');
    const answer = logged().find((e) => e.event === 'terminal_answer');
    assert.equal(answer.exit.exitCode, 0);
    assert.match(answer.output.output, /42/);
    const card = session.items.find((i) => i.kind === 'tool' && i.call.name === 'acp:terminal');
    assert.ok(card && card.kind === 'tool' && card.call.status === 'done' && /42/.test(card.liveOutput));
  });

  gitIt('stop sends session/cancel and cancels an open approval', async () => {
    let asked!: () => void;
    const askedPromise = new Promise<void>((resolve) => (asked = resolve));
    const { orchestrator, session } = setup([[{ chunk: 'working' }, { permission: { id: 'p1', kind: 'execute', title: 'rm -rf dist', rawInput: { command: 'rm -rf dist' } } }, { chunk: 'never shown' }]], {
      approve: () => {
        asked();
        return new Promise<ApprovalResponse>(() => {});
      },
    });
    const run = orchestrator.run('clean up');
    await askedPromise;
    orchestrator.stop();
    assert.equal(await run, 'stopped');
    const events = logged();
    assert.ok(events.some((e) => e.event === 'session/cancel'));
    assert.deepEqual(events.find((e) => e.event === 'permission_answer').outcome, { outcome: 'cancelled' });
    assert.equal(events.find((e) => e.event === 'prompt_done').stopReason, 'cancelled');
    const card = session.items.find((i) => i.kind === 'tool');
    assert.ok(card && card.kind === 'tool' && card.call.status === 'cancelled');
    assert.ok(!session.items.some((i) => i.kind === 'assistant' && i.text.includes('never shown')));
  });

  gitIt('an agent that is not signed in names its own login command', async () => {
    const { orchestrator, session } = setup([], { env: { FAKE_ACP_NEEDS_LOGIN: '1' } });
    assert.equal(await orchestrator.run('hello'), 'error');
    const notice = session.items.find((i) => i.kind === 'notice');
    assert.ok(notice && notice.kind === 'notice' && /Fake Agent is not signed in\. Run "fake login" in a terminal/.test(notice.message));
  });

  gitIt('the token budget cannot pause an agent that reports no tokens: said once', async () => {
    const { orchestrator, session } = setup([[{ chunk: 'a' }], [{ chunk: 'b' }]], { settings: { tokenBudget: 1000 } });
    await orchestrator.run('one');
    await orchestrator.run('two');
    assert.equal(session.items.filter((i) => i.kind === 'notice' && /token budget cannot pause it/.test(i.message)).length, 1);
    assert.equal(orchestrator.usageByAgent[0].calls, 2);
  });
});
