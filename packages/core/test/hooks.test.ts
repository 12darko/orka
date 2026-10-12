import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { hookCommandLine, hooksForFile, readHooks } from '../src/hooks/Hooks';
import { NodeHost, shellEnv } from '../src/host/NodeHost';
import type { AgentEvent } from '../src/orchestrator/events';
import { Orchestrator, type OrchestratorSettings } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import { call, lastToolResults, ScriptedProvider, tempWorkspace, text } from './helpers';

const BASE: OrchestratorSettings = { maxIterations: 30, autoVerify: false, commandTimeoutMs: 30_000 };

describe('Hooks', () => {
  let ws: ReturnType<typeof tempWorkspace>;

  beforeEach(() => {
    ws = tempWorkspace();
    mkdirSync(path.join(ws.root, 'src'));
    writeFileSync(path.join(ws.root, 'src', 'math.js'), 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n');
    // A hook that logs the file it was given, and a project check that fails until add() works.
    writeFileSync(path.join(ws.root, 'log-file.js'), "require('fs').appendFileSync('hook.log', process.argv[2] + '\\n');\n");
    writeFileSync(
      path.join(ws.root, 'check.js'),
      "const { add } = require('./src/math.js');\nif (add(2, 3) !== 5) { console.error('add(2, 3) returned ' + add(2, 3)); process.exit(1); }\nconsole.log('checks passed');\n",
    );
    writeFileSync(path.join(ws.root, 'fail.js'), "console.error('lint: 1 problem'); process.exit(3);\n");
  });
  afterEach(() => ws.cleanup());

  function setup(provider: ScriptedProvider, settings: OrchestratorSettings) {
    const host = new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) });
    const orchestrator = new Orchestrator({ host, getProvider: () => provider, permissions: new PermissionManager('balanced'), getSettings: () => settings });
    const events: AgentEvent[] = [];
    orchestrator.on((e) => events.push(e));
    return { orchestrator, events };
  }

  it('starts Windows PowerShell without a module path inherited from PowerShell 7', () => {
    const env = { PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', psmodulepath: 'x', PATH: '/bin' };
    const ps51 = shellEnv('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', { NO_COLOR: '1' }, env);
    assert.deepEqual(Object.keys(ps51).sort(), ['NO_COLOR', 'PATH']);
    assert.equal(shellEnv('pwsh.exe', {}, env).PSModulePath, env.PSModulePath, 'PowerShell 7 keeps its own');
    assert.equal(shellEnv('/bin/bash', {}, env).PSModulePath, env.PSModulePath);
  });

  it('reads hook settings defensively and matches files by glob', () => {
    const hooks = readHooks({
      afterEdit: ['npx prettier --write {file}', { command: 'eslint {file}', match: ['*.ts', 'src/**'] }, { command: '' }, { nope: 1 }],
      beforeFinish: [{ command: 'npm test', timeoutSeconds: 99999 }],
      other: 'ignored',
    });
    assert.equal(hooks.afterEdit.length, 2);
    assert.equal(hooks.beforeFinish[0].timeoutSeconds, 3600, 'timeouts are capped');
    assert.deepEqual(readHooks('nonsense'), { afterEdit: [], beforeFinish: [] });
    assert.deepEqual(hooksForFile(hooks.afterEdit, 'lib/a.ts').map((h) => h.command), ['npx prettier --write {file}', 'eslint {file}']);
    assert.deepEqual(hooksForFile(hooks.afterEdit, 'README.md').map((h) => h.command), ['npx prettier --write {file}']);
    assert.deepEqual(hookCommandLine(hooks.afterEdit[0], 'src/a b.ts'), { command: 'npx prettier --write "src/a b.ts"' });
    assert.ok('error' in hookCommandLine(hooks.afterEdit[0], 'src/$(rm -rf).ts'), 'paths that cannot be quoted safely are refused');
    assert.ok('error' in hookCommandLine(hooks.afterEdit[0]), '{file} needs a file');
  });

  it('runs afterEdit hooks on matching files and tells the agent the outcome', async () => {
    const provider = new ScriptedProvider([
      () => [call('write_file', { path: 'notes.md', content: '# Notes\n' })],
      (req) => {
        assert.doesNotMatch(lastToolResults(req)[0].content, /\[Hook/, 'notes.md does not match *.js');
        return [call('edit_file', { path: 'src/math.js', old_string: 'return a - b;', new_string: 'return a + b;' })];
      },
      (req) => {
        const result = lastToolResults(req)[0].content;
        assert.match(result, /\[Hook afterEdit\] `node log-file\.js "src\/math\.js"` passed \(exit code 0\)/);
        assert.match(result, /read it again before editing/);
        return [text('Fixed add().')];
      },
    ]);
    const { orchestrator, events } = setup(provider, { ...BASE, hooks: { afterEdit: [{ command: 'node log-file.js {file}', match: '*.js' }], beforeFinish: [] } });
    assert.equal(await orchestrator.run('fix add'), 'completed');
    assert.equal(readFileSync(path.join(ws.root, 'hook.log'), 'utf8'), 'src/math.js\n');
    assert.ok(events.some((e) => e.type === 'tool_call' && e.call.name === 'hook' && e.call.status === 'done'), 'the hook is shown in the chat');
    assert.equal(provider.remaining, 0);
  });

  it('sends the agent back when beforeFinish checks fail, and lets it finish once they pass', async () => {
    const provider = new ScriptedProvider([
      () => [call('edit_file', { path: 'src/math.js', old_string: 'return a - b;', new_string: 'return a * b;' })],
      () => [text('Done.')],
      (req) => {
        const last = req.messages[req.messages.length - 1];
        const note = (last.content[0] as { text: string }).text;
        assert.match(note, /project checks .* failed/i);
        assert.match(note, /`node check\.js` FAILED \(exit code 1\)/);
        assert.match(note, /add\(2, 3\) returned 6/);
        return [call('edit_file', { path: 'src/math.js', old_string: 'return a * b;', new_string: 'return a + b;' })];
      },
      () => [text('Now add() really works.')],
    ]);
    // autoVerify on: passing checks count as verification, so no extra "run the tests" nudge follows.
    const { orchestrator, events } = setup(provider, { ...BASE, autoVerify: true, hooks: { afterEdit: [], beforeFinish: [{ command: 'node check.js' }] } });
    assert.equal(await orchestrator.run('fix add'), 'completed');
    assert.equal(provider.remaining, 0);
    const hookRuns = events.filter((e) => e.type === 'tool_call' && e.call.name === 'hook' && e.call.status !== 'running');
    assert.deepEqual(
      hookRuns.map((e) => (e.type === 'tool_call' ? e.call.status : '')),
      ['error', 'done'],
    );
  });

  it('gives up on checks that keep failing after a few rounds, and skips them when nothing changed', async () => {
    const edit = (n: number) => () => [call('write_file', { path: `src/f${n}.js`, content: `module.exports = ${n};\n` })];
    const finish = () => [text('Done.')];
    const provider = new ScriptedProvider([edit(1), finish, edit(2), finish, edit(3), finish, edit(4), finish, finish]);
    const { orchestrator, events } = setup(provider, { ...BASE, hooks: { afterEdit: [], beforeFinish: [{ command: 'node fail.js' }] } });
    assert.equal(await orchestrator.run('do it'), 'completed');
    assert.equal(events.filter((e) => e.type === 'tool_call' && e.call.name === 'hook' && e.call.status === 'error').length, 3);
    assert.ok(events.some((e) => e.type === 'notice' && /still fail after 3 rounds/.test(e.message)));
    // A question that changes nothing never runs the checks.
    assert.equal(await orchestrator.run('what did you change?'), 'completed');
    assert.equal(events.filter((e) => e.type === 'tool_call' && e.call.name === 'hook' && e.call.status === 'error').length, 3);
    assert.equal(provider.remaining, 0);
    assert.ok(!existsSync(path.join(ws.root, 'hook.log')));
  });
});
