import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NodeHost } from '../src/host/NodeHost';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import type { AIProvider } from '../src/providers/AIProvider';
import { parseReview, type SupervisorSettings } from '../src/supervisor/Supervisor';
import { applyEvent, emptySession } from '../src/ui/transcript';
import { call, lastToolResults, ScriptedProvider, tempWorkspace, text } from './helpers';

const OK = '<verdict>ok</verdict>';
const intervene = (message: string) => `<verdict>intervene</verdict>\n<message>${message}</message>`;

describe('parseReview', () => {
  it('reads ok and intervene verdicts', () => {
    assert.deepEqual(parseReview(OK), { verdict: 'ok', message: '' });
    assert.deepEqual(parseReview(intervene('Stop editing tests.')), { verdict: 'intervene', message: 'Stop editing tests.' });
    assert.deepEqual(parseReview('<verdict>INTERVENE</verdict>\nUse the existing EventBus.'), { verdict: 'intervene', message: 'Use the existing EventBus.' });
    assert.equal(parseReview('Looks fine to me.').verdict, 'ok', 'no verdict tag = no intervention');
  });
});

describe('supervisor oversight', () => {
  let ws: ReturnType<typeof tempWorkspace>;

  beforeEach(() => {
    ws = tempWorkspace();
    mkdirSync(path.join(ws.root, 'src'));
    writeFileSync(path.join(ws.root, 'src', 'math.js'), 'function add(a, b) {\n  return a - b;\n}\n');
  });
  afterEach(() => ws.cleanup());

  function setup(main: AIProvider, supervisor: AIProvider, overrides: Partial<SupervisorSettings> = {}) {
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) }),
      getProvider: () => main,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 20, autoVerify: false, commandTimeoutMs: 30_000 }),
      supervisor: {
        getProvider: () => supervisor,
        getSettings: () => ({ enabled: true, frequency: 'on_changes', maxInterventions: 3, ...overrides }),
      },
    });
    const session = emptySession();
    orchestrator.on((e) => applyEvent(session, e));
    return { orchestrator, session };
  }

  it('corrects a wrong step: the guidance reaches the agent with its next results and shows in the chat', async () => {
    const supervisor = new ScriptedProvider([
      (req) => {
        assert.match(req.system, /You are the supervisor of an AI coding agent/);
        assert.equal(req.tools.length, 0, 'the supervisor has no tools');
        const first = (req.messages[0].content[0] as { text: string }).text;
        assert.match(first, /# Project[\s\S]*# The user's request\nMake add\(\) multiply[\s\S]*STEP REVIEW[\s\S]*Tool call: edit_file\(path=src\/math\.js/);
        return [text(intervene('The user asked for multiplication, not a comment. Change the return statement to a * b.'))];
      },
      (req) => {
        // The read_file turn is not reviewed (on_changes); the next edit is.
        assert.match((req.messages.at(-1)!.content[0] as { text: string }).text, /STEP REVIEW[\s\S]*return a \* b/);
        return [text(OK)];
      },
      (req) => {
        // The final review sees the task's real diff, not just file names.
        assert.match(
          (req.messages.at(-1)!.content[0] as { text: string }).text,
          /FINAL REVIEW[\s\S]*unified diff[\s\S]*\+\+\+ b\/src\/math\.js[\s\S]*-  return a - b;\n\+  return a \* b;/,
        );
        return [text(OK)];
      },
    ]);
    const main = new ScriptedProvider([
      () => [call('edit_file', { path: 'src/math.js', old_string: 'function add(a, b) {', new_string: '// multiply\nfunction add(a, b) {' })],
      () => [call('read_file', { path: 'src/math.js' })],
      (req) => {
        const last = req.messages.at(-1)!;
        assert.equal(last.role, 'user');
        assert.equal(last.content[0].type, 'tool_result', 'results first');
        assert.match((last.content[1] as { text: string }).text, /^\[Supervisor\] The user asked for multiplication/);
        return [call('edit_file', { path: 'src/math.js', old_string: 'return a - b;', new_string: 'return a * b;' })];
      },
      () => [text('add() now multiplies.')],
    ]);
    const { orchestrator, session } = setup(main, supervisor);

    assert.equal(await orchestrator.run('Make add() multiply'), 'completed');
    assert.equal(main.remaining, 0);
    const reviews = session.items.filter((i) => i.kind === 'supervisor');
    assert.deepEqual(
      reviews.map((r) => r.kind === 'supervisor' && [r.scope, r.status]),
      [
        ['step', 'intervened'],
        ['step', 'ok'],
        ['final', 'ok'],
      ],
    );
    assert.equal(supervisor.remaining, 0);
    const intervention = reviews.find((r) => r.kind === 'supervisor' && r.status === 'intervened');
    assert.match(intervention && intervention.kind === 'supervisor' ? intervention.message ?? '' : '', /multiplication/);
    // Supervisor tokens count toward the task total (4 main turns + supervisor turns, 5 output tokens each).
    assert.equal(orchestrator.totalUsage.outputTokens, 5 * (4 + supervisor.requests.length));
  });

  it('a final review can refuse "done" and send the agent back to work', async () => {
    const supervisor = new ScriptedProvider([
      () => [text(intervene('You never ran the tests. Run npm test before finishing.'))],
      () => [text(OK)],
    ]);
    const main = new ScriptedProvider([
      () => [text('All done!')],
      (req) => {
        assert.match((req.messages.at(-1)!.content[0] as { text: string }).text, /^\[Supervisor\] You never ran the tests/);
        return [text('Right - tests are not configured in this project, nothing to run.')];
      },
    ]);
    const { orchestrator, session } = setup(main, supervisor, { frequency: 'final_only' });
    assert.equal(await orchestrator.run('fix it'), 'completed');
    assert.equal(supervisor.requests.length, 2);
    assert.deepEqual(
      session.items.filter((i) => i.kind === 'supervisor').map((i) => i.kind === 'supervisor' && i.status),
      ['intervened', 'ok'],
    );
  });

  it('stops intervening after the configured limit', async () => {
    const supervisor = new ScriptedProvider(Array.from({ length: 5 }, () => () => [text(intervene('Not done yet.'))]));
    const main = new ScriptedProvider(Array.from({ length: 5 }, () => () => [text('Done.')]));
    const { orchestrator } = setup(main, supervisor, { frequency: 'final_only', maxInterventions: 2 });
    assert.equal(await orchestrator.run('go'), 'completed');
    assert.equal(supervisor.requests.length, 2);
    assert.equal(main.requests.length, 3);
  });

  it('a failing supervisor never breaks the agent', async () => {
    const broken: AIProvider = { id: 'x', label: 'Broken', model: 'x', chat: async () => Promise.reject(new Error('supervisor offline')) };
    const main = new ScriptedProvider([() => [call('edit_file', { path: 'src/math.js', old_string: 'a - b', new_string: 'a + b' })], () => [text('Fixed.')]]);
    const { orchestrator, session } = setup(main, broken);
    assert.equal(await orchestrator.run('fix add'), 'completed');
    const errors = session.items.filter((i) => i.kind === 'supervisor' && i.status === 'error');
    assert.ok(errors.length >= 1);
    assert.match(errors[0].kind === 'supervisor' ? errors[0].message ?? '' : '', /supervisor offline/);
  });

  it('blocking mode: the agent waits for each review, so a correction lands with the same step', async () => {
    const supervisor = new ScriptedProvider([() => [text(intervene('Wrong file - the bug is in the return statement.'))], () => [text(OK)], () => [text(OK)]]);
    const main = new ScriptedProvider([
      () => [call('edit_file', { path: 'src/math.js', old_string: 'function add(a, b) {', new_string: '// fix\nfunction add(a, b) {' })],
      (req) => {
        // In parallel mode this correction would only arrive one step later.
        const last = req.messages.at(-1)!;
        assert.match((last.content[1] as { text: string }).text, /^\[Supervisor\] Wrong file/);
        return [call('edit_file', { path: 'src/math.js', old_string: 'a - b', new_string: 'a + b' })];
      },
      () => [text('Fixed.')],
    ]);
    const { orchestrator } = setup(main, supervisor, { mode: 'blocking' });
    assert.equal(await orchestrator.run('fix add'), 'completed');
    assert.equal(main.remaining, 0);
    assert.equal(supervisor.remaining, 0);
  });

  describe('smart checkpoints (default)', () => {
    const lastText = (req: { messages: Array<{ content: unknown[] }> }) => {
      const blocks = req.messages.at(-1)!.content as Array<{ type: string; text?: string; content?: string }>;
      return blocks.map((b) => b.text ?? b.content ?? '').join('\n');
    };

    it('checks a new plan before the work starts, then stays quiet until the final review', async () => {
      const steps = (status: string) => [{ title: 'Change the return statement to multiply', status }];
      const supervisor = new ScriptedProvider([
        (req) => {
          assert.equal(req.messages.length, 1, 'checkpoints are stateless: one compact brief');
          assert.match(lastText(req), /PLAN CHECKPOINT[\s\S]*What the user asked[\s\S]*1\. Make add\(\) multiply[\s\S]*Change the return statement to multiply/);
          return [text(intervene('The plan has no verification step: run the tests after the change.'))];
        },
        (req) => {
          assert.equal(req.messages.length, 1);
          assert.match(lastText(req), /FINAL REVIEW[\s\S]*-  return a - b;\n\+  return a \* b;[\s\S]*Your earlier corrections[\s\S]*verification step[\s\S]*The agent's final answer[\s\S]*Done/);
          return [text(OK)];
        },
      ]);
      const main = new ScriptedProvider([
        (req) => {
          assert.ok(req.tools.some((tool) => tool.name === 'ask_supervisor'));
          assert.match(req.system, /# Supervisor[\s\S]*call ask_supervisor/);
          return [call('update_plan', { steps: steps('in_progress') })];
        },
        (req) => {
          assert.match(lastText(req), /\[Supervisor\] The plan has no verification step/, 'the plan correction arrives before any edit');
          return [call('edit_file', { path: 'src/math.js', old_string: 'return a - b;', new_string: 'return a * b;' })];
        },
        () => [call('update_plan', { steps: steps('completed') })],
        () => [text('Done')],
      ]);
      const { orchestrator, session } = setup(main, supervisor, { frequency: 'checkpoints' });
      assert.equal(await orchestrator.run('Make add() multiply'), 'completed');
      assert.equal(main.remaining, 0);
      assert.equal(supervisor.requests.length, 2, 'no reviews for the edit or the progress update');
      assert.deepEqual(
        session.items.filter((i) => i.kind === 'supervisor' && i.status !== 'reviewing').map((i) => i.kind === 'supervisor' && [i.scope, i.status]),
        [
          ['plan', 'intervened'],
          ['final', 'ok'],
        ],
      );
    });

    it('notices when the agent is stuck and brings the supervisor in', async () => {
      const failing = () => [call('run_command', { command: 'node -e "process.exit(3)"' })];
      const supervisor = new ScriptedProvider([
        (req) => {
          assert.match(lastText(req), /STUCK CHECKPOINT[\s\S]*Recent agent activity[\s\S]*run_command\(command=node -e "process\.exit\(3\)"\) -> ERROR: Exit code: 3[\s\S]*Why you are being asked\nthe same action failed twice/);
          return [text(intervene('That command always exits with 3; the bug is in src/math.js, not the environment.'))];
        },
        () => [text(OK)],
      ]);
      const main = new ScriptedProvider([
        failing,
        failing,
        (req) => {
          assert.match(lastText(req), /\[Supervisor\] That command always exits with 3/);
          return [text('Understood, the environment is fine.')];
        },
      ]);
      const { orchestrator, session } = setup(main, supervisor, { frequency: 'checkpoints' });
      assert.equal(await orchestrator.run('why does it fail?'), 'completed');
      const stuck = session.items.find((i) => i.kind === 'supervisor' && i.scope === 'stuck' && i.status === 'intervened');
      assert.equal(stuck && stuck.kind === 'supervisor' ? stuck.reason : '', 'the same action failed twice');
    });

    it('checks the direction after a long stretch without progress', async () => {
      const searches = Array.from({ length: 12 }, (_, i) => () => [call('search_code', { query: `term${i}` })]);
      const supervisor = new ScriptedProvider([
        (req) => {
          assert.match(lastText(req), /PROGRESS CHECKPOINT[\s\S]*12 steps without visible progress/);
          return [text(OK)];
        },
        () => [text(OK)],
      ]);
      const main = new ScriptedProvider([...searches, () => [text('Found nothing.')]]);
      const { orchestrator } = setup(main, supervisor, { frequency: 'checkpoints' });
      assert.equal(await orchestrator.run('look around'), 'completed');
      assert.equal(supervisor.requests.length, 2);
    });

    it('the agent can ask the supervisor; the advice comes back as the tool result', async () => {
      const supervisor = new ScriptedProvider([
        (req) => {
          assert.match(req.system, /asking you for guidance/);
          assert.match(lastText(req), /What the user asked[\s\S]*fix add[\s\S]*The agent's question\nShould I patch the tests or the function\?/);
          return [text('Fix the function: the tests describe the intended behavior.')];
        },
        () => [text(OK)],
      ]);
      const main = new ScriptedProvider([
        () => [call('ask_supervisor', { question: 'Should I patch the tests or the function?' })],
        (req) => {
          assert.match(lastText(req), /^\[Supervisor advice - scripted-model\]\nFix the function/);
          return [text('Fixing the function.')];
        },
      ]);
      const { orchestrator } = setup(main, supervisor, { frequency: 'checkpoints' });
      assert.equal(await orchestrator.run('fix add'), 'completed');
      const usage = orchestrator.usageByAgent.find((u) => u.agent === 'supervisor');
      assert.equal(usage?.calls, 2, 'the question and the final review');
    });

    it('without a supervisor the agent is not offered ask_supervisor', async () => {
      const main = new ScriptedProvider([
        (req) => {
          assert.ok(!req.tools.some((tool) => tool.name === 'ask_supervisor'));
          assert.doesNotMatch(req.system, /# Supervisor/);
          return [text('ok')];
        },
      ]);
      const { orchestrator } = setup(main, new ScriptedProvider([]), { enabled: false });
      assert.equal(await orchestrator.run('hi'), 'completed');
    });
  });

  it('read-only steps are not reviewed in on_changes mode', async () => {
    const supervisor = new ScriptedProvider([() => [text(OK)]]);
    const main = new ScriptedProvider([() => [call('read_file', { path: 'src/math.js' })], () => [text('It subtracts.')]]);
    const { orchestrator } = setup(main, supervisor);
    await orchestrator.run('what does add do?');
    assert.equal(supervisor.requests.length, 1, 'only the final review');
    assert.match((supervisor.requests[0].messages[0].content[0] as { text: string }).text, /FINAL REVIEW/);
    assert.ok(lastToolResults.length >= 0);
  });
});
