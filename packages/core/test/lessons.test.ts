import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NodeHost } from '../src/host/NodeHost';
import { appendLessons, parseLessons } from '../src/memory/ProjectMemory';
import type { AgentEvent } from '../src/orchestrator/events';
import { Orchestrator, type OrchestratorSettings } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import { call, ScriptedProvider, tempWorkspace, text } from './helpers';

const SETTINGS: OrchestratorSettings = { maxIterations: 20, autoVerify: false, commandTimeoutMs: 30_000 };

describe('Lessons in the project memory', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => {
    ws = tempWorkspace();
    writeFileSync(path.join(ws.root, 'app.js'), 'module.exports = 1;\n');
  });
  afterEach(() => ws.cleanup());

  function setup(provider: ScriptedProvider, settings = SETTINGS) {
    const host = new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) });
    const orchestrator = new Orchestrator({ host, getProvider: () => provider, permissions: new PermissionManager('balanced'), getSettings: () => settings });
    const events: AgentEvent[] = [];
    orchestrator.on((e) => events.push(e));
    return { orchestrator, events, host };
  }

  it('parses lesson lines and ignores NONE, prose and fragments', () => {
    assert.deepEqual(parseLessons('NONE'), []);
    assert.deepEqual(parseLessons('Here you go:\n- Run tests with `npm test -w core`.\n* Unity builds need the Library folder closed first.\n- ok\n- 4th\n- fifth lesson that is long enough\n- sixth lesson that is long enough'), [
      'Run tests with `npm test -w core`.',
      'Unity builds need the Library folder closed first.',
      'fifth lesson that is long enough',
    ]);
  });

  it('appends only new lessons, keeps notes the user wrote, and needs the memory folder', async () => {
    const host = new NodeHost({ workspaceRoot: ws.root });
    assert.equal(await appendLessons(host, ['Build with npm run build.']), undefined, 'no .project-ai/: nothing is written');
    mkdirSync(path.join(ws.root, '.project-ai'));
    const first = await appendLessons(host, ['Build with npm run build.', 'Tests need a running Postgres.']);
    assert.deepEqual(first?.added, ['Build with npm run build.', 'Tests need a running Postgres.']);
    const file = path.join(ws.root, '.project-ai', 'lessons.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nMy own note stays.\n`);
    const second = await appendLessons(host, ['build with NPM run build', 'Use pnpm, not npm, for installs.']);
    assert.deepEqual(second?.added, ['Use pnpm, not npm, for installs.'], 'a lesson that differs only in case and punctuation is a duplicate');
    const content = readFileSync(file, 'utf8');
    assert.match(content, /^# Lessons/);
    assert.match(content, /My own note stays\./);
    assert.equal(content.match(/^- /gm)?.length, 3);
    assert.equal(await appendLessons(host, ['Tests need a running Postgres.']), undefined);
  });

  it('asks for lessons after a request that changed code, records them as a reviewable change, and stays append-only', async () => {
    mkdirSync(path.join(ws.root, '.project-ai'));
    const provider = new ScriptedProvider([
      () => [call('edit_file', { path: 'app.js', old_string: '1', new_string: '2' })],
      () => [text('Changed it to 2.')],
      (req) => {
        const last = req.messages[req.messages.length - 1];
        assert.match((last.content[0] as { text: string }).text, /durable, project-specific lessons/);
        return [text('- Run `node app.js` to check the module loads.\n- The exported number is read by the deploy script.')];
      },
      // A question without changes asks for nothing, and the conversation kept the earlier exchange.
      (req) => {
        assert.ok(req.messages.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text' && b.text.includes('deploy script'))));
        return [text('It is 2 now.')];
      },
    ]);
    const { orchestrator, events } = setup(provider);
    assert.equal(await orchestrator.run('change the number'), 'completed');
    const lessons = readFileSync(path.join(ws.root, '.project-ai', 'lessons.md'), 'utf8');
    assert.match(lessons, /- Run `node app\.js` to check the module loads\./);
    assert.ok(events.some((e) => e.type === 'notice' && /lessons\.md/.test(e.message)));
    assert.deepEqual((await orchestrator.changes.list()).map((c) => c.relPath).sort(), ['.project-ai/lessons.md', 'app.js']);
    assert.equal(await orchestrator.run('what is the number?'), 'completed');
    assert.equal(provider.remaining, 0);
  });

  it('can be turned off, and never runs without a memory folder', async () => {
    const provider = new ScriptedProvider([() => [call('edit_file', { path: 'app.js', old_string: '1', new_string: '2' })], () => [text('Done.')]]);
    const { orchestrator } = setup(provider);
    assert.equal(await orchestrator.run('change it'), 'completed');
    mkdirSync(path.join(ws.root, '.project-ai'));
    const off = new ScriptedProvider([() => [call('edit_file', { path: 'app.js', old_string: '2', new_string: '3' })], () => [text('Done.')]]);
    const second = setup(off, { ...SETTINGS, learnLessons: false });
    assert.equal(await second.orchestrator.run('change it again'), 'completed');
    assert.equal(provider.remaining + off.remaining, 0);
    assert.ok(!existsSync(path.join(ws.root, '.project-ai', 'lessons.md')));
  });
});
