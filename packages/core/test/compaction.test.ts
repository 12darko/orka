import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NodeHost } from '../src/host/NodeHost';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import type { ChatResponse } from '../src/providers/AIProvider';
import { applyEvent, emptySession } from '../src/ui/transcript';
import type { AssistantMessage, ChatMessage } from '../src/types';
import { call, ScriptedProvider, tempWorkspace, text } from './helpers';

/** A scripted turn that reports a large prompt, to cross the compaction threshold. */
function big(content: AssistantMessage['content'], inputTokens = 5000): ChatResponse {
  const hasCalls = content.some((b) => b.type === 'tool_call');
  return {
    message: { role: 'assistant', content },
    stopReason: hasCalls ? 'tool_use' : 'end_turn',
    usage: { inputTokens, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'scripted-model',
  };
}

const lastText = (req: { messages: ChatMessage[] }) => {
  const last = req.messages[req.messages.length - 1];
  return last.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
};

describe('compaction', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => {
    ws = tempWorkspace();
    mkdirSync(path.join(ws.root, 'src'));
    writeFileSync(path.join(ws.root, 'src', 'math.js'), 'function add(a, b) {\n  return a - b;\n}\n');
  });
  afterEach(() => ws.cleanup());

  function setup(main: ScriptedProvider, thresholdTokens = 1000) {
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) }),
      getProvider: () => main,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 10, autoVerify: false, commandTimeoutMs: 30_000, compaction: { auto: true, thresholdTokens } }),
    });
    const session = emptySession();
    orchestrator.on((e) => applyEvent(session, e));
    return { orchestrator, session };
  }

  it('compacts automatically past the threshold into a handoff with the orchestrator state', async () => {
    const main = new ScriptedProvider([
      () => big([call('update_plan', { steps: [{ title: 'Fix add', status: 'in_progress' }] })], 100),
      () => big([call('edit_file', { path: 'src/math.js', old_string: 'a - b', new_string: 'a + b' })]),
      (req) => {
        // The compaction request: same history plus the orchestrator's instruction, results first.
        assert.match(lastText(req), /\[Orchestrator\] This conversation is getting long and will now be compacted/);
        assert.equal(req.messages.at(-1)!.content[0].type, 'tool_result');
        return big([text('NOTE: user wants add() to add. Changed the operator in src/math.js. Next: run tests.')], 100);
      },
      (req) => {
        assert.equal(req.messages.length, 1, 'history replaced by one handoff message');
        const handoff = lastText(req);
        assert.match(handoff, /^\[Task handoff\]/);
        assert.match(handoff, /<handoff_note>\nNOTE: user wants add\(\) to add/);
        assert.match(handoff, /User requests in this task \(verbatim, oldest first\):\n1\. Fix add\(\) please/);
        assert.match(handoff, /Plan:\n\[>\] 1\. Fix add/);
        assert.match(handoff, /Files changed in this task:\n- modified src\/math\.js \(\+1 -1\)/);
        assert.match(handoff, /Results of your most recent tool calls:\n<result>\nEdited src\/math\.js/);
        return big([text('Continuing: done.')], 200);
      },
    ]);
    const { orchestrator, session } = setup(main);
    assert.equal(await orchestrator.run('Fix add() please'), 'completed');
    assert.equal(main.remaining, 0);
    const compactions = session.items.filter((i) => i.kind === 'compaction');
    assert.equal(compactions.length, 1);
    const c = compactions[0];
    assert.ok(c.kind === 'compaction' && c.status === 'done' && c.reason === 'auto');
    assert.equal(c.kind === 'compaction' && c.beforeTokens, 5000);
    assert.ok(c.kind === 'compaction' && (c.afterTokens ?? 0) < 1000);
    assert.equal(orchestrator.history.length, 2, 'handoff + final answer');
  });

  it('compacts on request between runs', async () => {
    const main = new ScriptedProvider([
      () => [call('read_file', { path: 'src/math.js' })],
      () => [text('It subtracts.')],
      (req) => {
        assert.equal(req.messages.at(-1)!.role, 'user');
        assert.match(lastText(req), /will now be compacted/);
        return [text('NOTE: explained that add() subtracts.')];
      },
    ]);
    const { orchestrator } = setup(main, 1_000_000);
    await orchestrator.run('what does add do?');
    assert.equal(await orchestrator.compact(), true);
    assert.equal(orchestrator.history.length, 1);
    assert.match((orchestrator.history[0].content[0] as { text: string }).text, /NOTE: explained that add\(\) subtracts/);
  });

  it('a failed compaction keeps the full history and the task goes on', async () => {
    const main = new ScriptedProvider([
      () => big([call('read_file', { path: 'src/math.js' })]),
      () => big([text('')], 100), // empty note -> compaction error
      (req) => {
        assert.ok(req.messages.length > 1, 'full history kept');
        return [text('Answer on the full history.')];
      },
    ]);
    const { orchestrator, session } = setup(main);
    assert.equal(await orchestrator.run('go'), 'completed');
    const c = session.items.find((i) => i.kind === 'compaction');
    assert.ok(c && c.kind === 'compaction' && c.status === 'error' && /empty handoff note/.test(c.message ?? ''));
  });
});
