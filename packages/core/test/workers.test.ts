import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_SUBAGENTS } from '../src/agents/subagents';
import { ShadowGit } from '../src/changes/ShadowGit';
import { NodeHost } from '../src/host/NodeHost';
import type { AgentEvent } from '../src/orchestrator/events';
import { Orchestrator, type OrchestratorSettings } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import type { AIProvider, ChatRequest, ChatResponse } from '../src/providers/AIProvider';
import type { AssistantMessage } from '../src/types';
import { call, lastToolResults, ScriptedProvider, tempWorkspace, text } from './helpers';

const SETTINGS: OrchestratorSettings = { maxIterations: 20, autoVerify: false, commandTimeoutMs: 30_000, maxParallelSubagents: 3 };
const SHARED = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** Plays a script per worker, chosen by a marker in its task, so workers running at once stay apart. */
class WorkerProvider implements AIProvider {
  readonly id = 'workers';
  readonly label = 'Workers';
  readonly model = 'worker-model';
  readonly roots: string[] = [];
  readonly tasks: string[] = [];
  /** Workers between their first and last step. */
  private readonly active = new Set<string>();
  concurrent = false;

  constructor(private readonly scripts: Record<string, Array<() => AssistantMessage['content']>>) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const first = request.messages[0].content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const name = Object.keys(this.scripts).find((key) => first.includes(key))!;
    const step = request.messages.filter((m) => m.role === 'assistant').length;
    if (step === 0) {
      this.roots.push(/Workspace root: (.+?) \(/.exec(request.system)![1]);
      this.tasks.push(first);
      this.active.add(name);
      // Wait (briefly) for the other worker: it only shows up when they really run at the same time.
      for (let i = 0; i < 40 && this.active.size < Object.keys(this.scripts).length; i++) await new Promise((r) => setTimeout(r, 50));
      if (this.active.size === Object.keys(this.scripts).length) this.concurrent = true;
    }
    const content = this.scripts[name][step]();
    if (step === this.scripts[name].length - 1) this.active.delete(name);
    return {
      message: { role: 'assistant', content },
      stopReason: content.some((b) => b.type === 'tool_call') ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: this.model,
    };
  }
}

describe('Workers side by side', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let gitDir: ReturnType<typeof tempWorkspace>;
  const read = (name: string) => readFileSync(path.join(ws.root, name), 'utf8');

  beforeEach(() => {
    ws = tempWorkspace();
    gitDir = tempWorkspace();
    mkdirSync(path.join(ws.root, 'src'));
    writeFileSync(path.join(ws.root, 'src', 'a.js'), 'export const a = 1;\n');
    writeFileSync(path.join(ws.root, 'src', 'b.js'), 'export const b = 1;\n');
    writeFileSync(path.join(ws.root, 'shared.txt'), SHARED);
    writeFileSync(path.join(ws.root, 'conflict.txt'), 'color = red\n');
  });
  afterEach(() => {
    ws.cleanup();
    gitDir.cleanup();
  });

  it('run in their own copies at the same time, then their changes are merged; overlapping edits are reported', async () => {
    const workers = new WorkerProvider({
      'WORKER-ONE': [
        () => [
          call('edit_file', { path: 'src/a.js', old_string: 'a = 1', new_string: 'a = 2' }),
          call('edit_file', { path: 'shared.txt', old_string: 'line 1\n', new_string: 'line 1 (one)\n' }),
          call('edit_file', { path: 'conflict.txt', old_string: 'red', new_string: 'blue' }),
        ],
        () => [text('One: a = 2.')],
      ],
      'WORKER-TWO': [
        () => [
          call('edit_file', { path: 'src/b.js', old_string: 'b = 1', new_string: 'b = 2' }),
          call('write_file', { path: 'src/c.js', content: 'export const c = 3;\n' }),
          call('edit_file', { path: 'shared.txt', old_string: 'line 12\n', new_string: 'line 12 (two)\n' }),
          call('edit_file', { path: 'conflict.txt', old_string: 'red', new_string: 'green' }),
        ],
        () => [text('Two: b = 2, c added.')],
      ],
    });
    const main = new ScriptedProvider([
      () => [call('run_subagent', { agent: 'worker', task: 'WORKER-ONE: change a' }), call('run_subagent', { agent: 'worker', task: 'WORKER-TWO: change b' })],
      (req) => {
        const [one, two] = lastToolResults(req).map((r) => r.content);
        assert.match(one, /One: a = 2\./);
        assert.match(one, /Merged into the workspace: conflict\.txt, shared\.txt, src\/a\.js\./);
        assert.match(two, /Merged into the workspace: shared\.txt \(merged\), src\/b\.js, src\/c\.js\./);
        assert.match(two, /CONFLICT in conflict\.txt/);
        assert.match(two, /\+color = green/);
        return [text('Both workers are done; I will settle the color.')];
      },
    ]);
    const host = new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) });
    const orchestrator = new Orchestrator({
      host,
      getProvider: () => main,
      permissions: new PermissionManager('balanced'),
      getSettings: () => SETTINGS,
      subagents: { getProfiles: () => DEFAULT_SUBAGENTS, getProvider: () => workers },
      commandSnapshots: new ShadowGit(ws.root, gitDir.root),
    });
    const events: AgentEvent[] = [];
    orchestrator.on((e) => events.push(e));

    assert.equal(await orchestrator.run('change a and b with two workers'), 'completed');
    assert.equal(main.remaining, 0);
    assert.ok(workers.concurrent, 'the two workers ran at the same time');
    assert.equal(workers.roots.length, 2);
    for (const root of workers.roots) {
      assert.notEqual(path.resolve(root), path.resolve(ws.root), 'each worker works in its own copy');
      assert.ok(!existsSync(root), 'the copy is removed afterwards');
    }
    assert.ok(workers.tasks.every((task) => task.includes('your own copy of the project')));

    assert.equal(read('src/a.js'), 'export const a = 2;\n');
    assert.equal(read('src/b.js'), 'export const b = 2;\n');
    assert.equal(read('src/c.js'), 'export const c = 3;\n');
    assert.equal(read('shared.txt'), SHARED.replace('line 1\n', 'line 1 (one)\n').replace('line 12\n', 'line 12 (two)\n'), 'both edits merged');
    assert.equal(read('conflict.txt'), 'color = blue\n', 'the first worker wins a conflict');
    assert.ok(events.some((e) => e.type === 'notice' && /conflict\.txt/.test(e.message)));
    assert.deepEqual((await orchestrator.changes.list()).map((c) => `${c.relPath} ${c.status}`), [
      'conflict.txt modified',
      'shared.txt modified',
      'src/a.js modified',
      'src/b.js modified',
      'src/c.js added',
    ]);
  });

  it('run one after another in the workspace when there are no snapshots', async () => {
    const workers = new WorkerProvider({
      'WORKER-ONE': [() => [call('edit_file', { path: 'src/a.js', old_string: 'a = 1', new_string: 'a = 2' })], () => [text('One done.')]],
      'WORKER-TWO': [() => [call('edit_file', { path: 'src/b.js', old_string: 'b = 1', new_string: 'b = 2' })], () => [text('Two done.')]],
    });
    const main = new ScriptedProvider([
      () => [call('run_subagent', { agent: 'worker', task: 'WORKER-ONE: change a' }), call('run_subagent', { agent: 'worker', task: 'WORKER-TWO: change b' })],
      () => [text('Done.')],
    ]);
    const host = new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) });
    const orchestrator = new Orchestrator({
      host,
      getProvider: () => main,
      permissions: new PermissionManager('balanced'),
      getSettings: () => SETTINGS,
      subagents: { getProfiles: () => DEFAULT_SUBAGENTS, getProvider: () => workers },
    });
    assert.equal(await orchestrator.run('two workers'), 'completed');
    assert.ok(!workers.concurrent);
    assert.ok(workers.roots.every((root) => path.resolve(root) === path.resolve(ws.root)));
    assert.equal(read('src/a.js'), 'export const a = 2;\n');
    assert.equal(read('src/b.js'), 'export const b = 2;\n');
  });
});
