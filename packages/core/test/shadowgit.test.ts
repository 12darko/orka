import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { ShadowGit } from '../src/changes/ShadowGit';
import { recordChangesSince } from '../src/handoff/Handoff';
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

describe('originals taken from a snapshot', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let store: ReturnType<typeof tempWorkspace>;
  let shadow: ShadowGit;
  const file = (name: string) => path.join(ws.root, name);
  const gitDir = () => path.join(store.root, 'shadow.git');
  beforeEach(() => {
    ws = tempWorkspace();
    store = tempWorkspace();
    shadow = new ShadowGit(ws.root, gitDir());
    writeFileSync(file('.gitattributes'), '* text=auto\n*.cs text eol=crlf\n');
    writeFileSync(file('.gitignore'), '*.log\n');
    writeFileSync(file('Player.cs'), 'line1\r\nline2\r\n');
    writeFileSync(file('a.txt'), 'a0\n');
    writeFileSync(file('debug.log'), 'log0\n');
  });
  afterEach(() => {
    ws.cleanup();
    store.cleanup();
  });

  it('are the file as the working tree had it; the disk only where it is that file or only it can say', async () => {
    const snap = (await shadow.snapshot())!;
    assert.ok(snap);
    assert.equal(await shadow.originalAt(snap, 'Player.cs'), undefined, 'unchanged since: the exact bytes on disk');
    writeFileSync(file('Player.cs'), 'line1\r\nchanged unseen\r\n');
    assert.equal(await shadow.originalAt(snap, 'Player.cs'), 'line1\r\nline2\r\n', 'changed since: with the line endings a checkout writes');
    assert.equal(await shadow.contentAt(snap, 'Player.cs'), 'line1\r\nline2\r\n');
    rmSync(file('Player.cs'));
    assert.equal(await shadow.originalAt(snap, 'Player.cs'), 'line1\r\nline2\r\n', 'deleted since');
    writeFileSync(file('new.txt'), 'created unseen\n');
    assert.equal(await shadow.originalAt(snap, 'new.txt'), null, 'created since');
    assert.equal(await shadow.originalAt(snap, 'missing.txt'), undefined, 'not on disk either: the disk says it does not exist');
    writeFileSync(file('debug.log'), 'log1\n');
    assert.equal(await shadow.originalAt(snap, 'debug.log'), undefined, 'ignored: only the disk can say');
    writeFileSync(file('[x].txt'), 'x\n');
    assert.equal(await shadow.originalAt(snap, '[x].txt'), null, 'paths are taken literally');
  });

  it('a file inside an embedded repository is never taken for a new one', async (t) => {
    mkdirSync(file('sub'));
    writeFileSync(file('sub/s.txt'), 's0\n');
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: file('sub'), windowsHide: true }).status;
    if (git('init', '-q') !== 0 || git('add', '.') !== 0 || git('commit', '-qm', 's') !== 0) return t.skip('no git');
    const snap = (await shadow.snapshot())!;
    writeFileSync(file('sub/s.txt'), 's1\n');
    writeFileSync(file('sub/t.txt'), 't\n');
    assert.equal(await shadow.originalAt(snap, 'sub/s.txt'), undefined);
    assert.equal(await shadow.originalAt(snap, 'sub/t.txt'), undefined);
  });

  it('a Git LFS file comes back from the object the snapshots kept, never as its pointer', async () => {
    const content = 'big text asset\n';
    const oid = createHash('sha256').update(content).digest('hex');
    // What the LFS clean filter leaves in a snapshot: the pointer; the object goes to the snapshots' own store.
    writeFileSync(file('asset.txt'), `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`);
    const snap = (await shadow.snapshot())!;
    writeFileSync(file('asset.txt'), 'changed unseen\n');
    assert.equal(await shadow.originalAt(snap, 'asset.txt'), undefined, 'the object is not there: only the disk can say');
    const object = path.join(gitDir(), 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
    mkdirSync(path.dirname(object), { recursive: true });
    writeFileSync(object, content);
    assert.equal(await shadow.originalAt(snap, 'asset.txt'), content);
    assert.equal(await shadow.contentAt(snap, 'asset.txt'), content);
  });

  it('files changed since a snapshot get their content as the working tree had it; one git cannot read is never "did not exist"', async () => {
    const tracker = new ChangeTracker(new NodeHost({ workspaceRoot: ws.root }));
    const snap = (await shadow.snapshot())!;
    tracker.startEpoch();
    // The snapshot lost a.txt's content (git fails to read it).
    const blob = createHash('sha1').update('blob 3\0a0\n').digest('hex');
    const object = path.join(gitDir(), 'objects', blob.slice(0, 2), blob.slice(2));
    chmodSync(object, 0o666);
    rmSync(object);
    writeFileSync(file('a.txt'), 'a1\n');
    writeFileSync(file('Player.cs'), 'line1\r\nchanged by a command\r\n');
    const recorded = await recordChangesSince(shadow, snap, tracker, ws.root);
    assert.deepEqual(recorded.map((c) => c.path), ['Player.cs']);
    assert.equal(tracker.getOriginal(file('Player.cs')), 'line1\r\nline2\r\n');
    assert.equal(tracker.isTracked(file('a.txt')), false);
    await tracker.rewindTo(0);
    assert.equal(readFileSync(file('a.txt'), 'utf8'), 'a1\n', 'not deleted');
    assert.equal(readFileSync(file('Player.cs'), 'utf8'), 'line1\r\nline2\r\n');
  });
});
