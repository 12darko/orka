import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { ShadowGit } from '../src/changes/ShadowGit';
import { externalAgent, findExecutable, Handoff, handoffBrief, userRequests } from '../src/handoff/Handoff';
import { NodeHost } from '../src/host/NodeHost';
import type { ChatMessage } from '../src/types';
import { tempWorkspace } from './helpers';

describe('hand-off to an external agent (Freebuff)', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let store: ReturnType<typeof tempWorkspace>;
  beforeEach(() => {
    ws = tempWorkspace();
    store = tempWorkspace();
    writeFileSync(path.join(ws.root, 'cart.ts'), 'export const total = 100;\n');
    writeFileSync(path.join(ws.root, 'old.ts'), 'legacy\n');
  });
  afterEach(() => {
    ws.cleanup();
    store.cleanup();
  });

  it('picks up what the other agent changed, and it can be reverted like Orka\'s own edits', async (t) => {
    const host = new NodeHost({ workspaceRoot: ws.root });
    const changes = new ChangeTracker(host);
    const snapshots = new ShadowGit(ws.root, path.join(store.root, 'shadow.git'));
    const handoff = new Handoff(externalAgent('freebuff')!, ws.root, snapshots, changes);
    if (!(await handoff.begin())) return t.skip(`snapshots unavailable: ${handoff.untrackedReason}`);
    assert.equal(handoff.active, true);

    // What Freebuff does in its own terminal:
    writeFileSync(path.join(ws.root, 'cart.ts'), 'export const total = 90;\n');
    writeFileSync(path.join(ws.root, 'coupon.ts'), 'export const code = "SAVE10";\n');
    rmSync(path.join(ws.root, 'old.ts'));

    const changed = await handoff.collect();
    assert.deepEqual(changed.map((c) => `${c.path}:${c.status}`).sort(), ['cart.ts:modified', 'coupon.ts:added', 'old.ts:deleted']);
    assert.equal(handoff.active, false);
    const listed = await changes.list();
    assert.deepEqual(listed.map((c) => c.relPath).sort(), ['cart.ts', 'coupon.ts', 'old.ts']);
    assert.match(await changes.unifiedDiffs(), /-export const total = 100;\n\+export const total = 90;/);

    await changes.revertAll();
    assert.equal(readFileSync(path.join(ws.root, 'cart.ts'), 'utf8'), 'export const total = 100;\n');
    assert.equal(existsSync(path.join(ws.root, 'coupon.ts')), false);
    assert.equal(readFileSync(path.join(ws.root, 'old.ts'), 'utf8'), 'legacy\n');
  });

  it('keeps tracking a hand-off that goes on, and reports files Orka had already changed', async (t) => {
    const host = new NodeHost({ workspaceRoot: ws.root });
    const changes = new ChangeTracker(host);
    const snapshots = new ShadowGit(ws.root, path.join(store.root, 'shadow.git'));
    // Orka changed cart.ts before handing off.
    changes.recordOriginal(path.join(ws.root, 'cart.ts'), 'export const total = 100;\n');
    writeFileSync(path.join(ws.root, 'cart.ts'), 'export const total = 95;\n');
    const handoff = new Handoff(externalAgent('freebuff')!, ws.root, snapshots, changes);
    if (!(await handoff.begin())) return t.skip(`snapshots unavailable: ${handoff.untrackedReason}`);

    writeFileSync(path.join(ws.root, 'cart.ts'), 'export const total = 90;\n');
    assert.deepEqual((await handoff.collect(true)).map((c) => c.path), ['cart.ts']);
    assert.equal(handoff.active, true, 'still watching');
    assert.match(await changes.unifiedDiffs(), /-export const total = 100;/, 'the original from before Orka stays');

    writeFileSync(path.join(ws.root, 'later.ts'), 'x\n');
    assert.deepEqual((await handoff.collect()).map((c) => c.path), ['later.ts'], 'only changes since the last collect');
  });

  it('writes a brief with the requests, the plan and the changed files', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '<context>\nOS: Windows\n</context>\n\nFix the coupon\n\n<attached_file path="cart.ts">\nx\n</attached_file>' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 't', content: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'Supervisor: check the tests.' }] },
      { role: 'user', content: [{ type: 'text', text: '<context>\n</context>\n\nand make it case-insensitive' }] },
    ];
    const requests = userRequests(messages);
    assert.deepEqual(requests, ['Fix the coupon', 'and make it case-insensitive']);
    const brief = handoffBrief({
      requests,
      plan: { steps: [{ title: 'Read cart.ts', status: 'completed' }, { title: 'Fix applyCoupon', status: 'in_progress' }] },
      changedFiles: ['cart.ts'],
    });
    assert.match(brief, /^Task \(the user's requests, oldest first\):\n- Fix the coupon\n- and make it case-insensitive/);
    assert.match(brief, /\[x\] 1\. Read cart\.ts\n\[>\] 2\. Fix applyCoupon/);
    assert.match(brief, /Files already changed for this task:\n- cart\.ts/);
    assert.equal(handoffBrief({ requests: [] }), '');
  });

  it('finds executables on PATH', () => {
    assert.ok(findExecutable('node'), 'node is on PATH');
    assert.equal(findExecutable('definitely-not-a-real-command-xyz'), undefined);
  });

  it('on Windows picks the runnable .cmd, not the shell script npm puts next to it', () => {
    // What "npm install -g freebuff" leaves in the npm folder.
    writeFileSync(path.join(store.root, 'freebuff'), '#!/bin/sh\n');
    writeFileSync(path.join(store.root, 'freebuff.cmd'), '@echo off\r\n');
    const env = { PATH: store.root, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(findExecutable('freebuff', env, 'win32'), path.join(store.root, 'freebuff.cmd'));
    assert.equal(findExecutable('freebuff', { PATH: store.root }, 'linux'), path.join(store.root, 'freebuff'));
  });
});
