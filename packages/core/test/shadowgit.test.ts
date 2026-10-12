import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ShadowGit } from '../src/changes/ShadowGit';
import { NodeHost } from '../src/host/NodeHost';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import { call, ScriptedProvider, tempWorkspace, text } from './helpers';

describe('changes made by terminal commands', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let store: ReturnType<typeof tempWorkspace>;
  beforeEach(() => {
    ws = tempWorkspace();
    store = tempWorkspace();
    writeFileSync(path.join(ws.root, 'a.txt'), 'one\r\ntwo\r\n');
    writeFileSync(path.join(ws.root, 'gone.txt'), 'bye\n');
    mkdirSync(path.join(ws.root, 'node_modules'));
  });
  afterEach(() => {
    ws.cleanup();
    store.cleanup();
  });

  it('are listed, reported to the agent, and revertible like its own edits', async () => {
    const script = [
      "const fs = require('fs');",
      "fs.appendFileSync('a.txt', 'three\\r\\n');",
      "fs.writeFileSync('gen.txt', 'generated');",
      "fs.rmSync('gone.txt');",
      "fs.writeFileSync('node_modules/pkg.js', 'ignored');",
    ].join(' ');
    writeFileSync(path.join(ws.root, 'change.js'), script);
    const main = new ScriptedProvider([
      () => [call('run_command', { command: 'node change.js' })],
      (req) => {
        const result = req.messages.at(-1)!.content[0] as { content: string };
        assert.match(result.content, /Files changed by this command \(revertible in the Changes panel\): /);
        assert.match(result.content, /a\.txt \(modified\)/);
        assert.match(result.content, /gen\.txt \(added\)/);
        assert.match(result.content, /gone\.txt \(deleted\)/);
        assert.doesNotMatch(result.content, /node_modules/, 'ignored folders are not tracked');
        return [text('done')];
      },
    ]);
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root }),
      getProvider: () => main,
      permissions: new PermissionManager('autonomous'),
      getSettings: () => ({ maxIterations: 5, autoVerify: false, commandTimeoutMs: 30_000 }),
      commandSnapshots: new ShadowGit(ws.root, path.join(store.root, 'shadow.git')),
    });
    assert.equal(await orchestrator.run('run the generator'), 'completed');
    const changes = await orchestrator.changes.list();
    assert.deepEqual(changes.map((c) => [c.relPath, c.status]), [
      ['a.txt', 'modified'],
      ['gen.txt', 'added'],
      ['gone.txt', 'deleted'],
    ]);
    await orchestrator.changes.revertAll();
    assert.equal(readFileSync(path.join(ws.root, 'a.txt'), 'utf8'), 'one\r\ntwo\r\n', 'exact bytes, CRLF kept');
    assert.equal(existsSync(path.join(ws.root, 'gen.txt')), false);
    assert.equal(readFileSync(path.join(ws.root, 'gone.txt'), 'utf8'), 'bye\n');
    assert.equal(existsSync(path.join(ws.root, '.git')), false, "the user's folder gets no .git");
  });

  it('read-only commands take no snapshot', async () => {
    const shadow = new ShadowGit(ws.root, path.join(store.root, 'shadow.git'));
    let snapshots = 0;
    const original = shadow.snapshot.bind(shadow);
    shadow.snapshot = async () => {
      snapshots++;
      return original();
    };
    const main = new ScriptedProvider([() => [call('run_command', { command: 'git status' })], () => [text('ok')]]);
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root }),
      getProvider: () => main,
      permissions: new PermissionManager('autonomous'),
      getSettings: () => ({ maxIterations: 5, autoVerify: false, commandTimeoutMs: 30_000 }),
      commandSnapshots: shadow,
    });
    await orchestrator.run('status?');
    assert.equal(snapshots, 0);
  });
});
