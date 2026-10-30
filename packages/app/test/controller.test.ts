import { applyEvent, emptySession, FileTaskStore, VERSION } from '@orka/core';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppController } from '../src/AppController';
import { FakeShell } from './fakeShell';

let home: string;
let folderA: string;
let folderB: string;
let controllers: AppController[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-app-test-'));
  folderA = path.join(home, 'work', 'alpha');
  folderB = path.join(home, 'work', 'beta');
  for (const dir of [folderA, folderB, path.join(home, 'builtin-skills')]) mkdirSync(dir, { recursive: true });
  process.env.ORKA_NO_UPDATE_CHECK = '1';
});

afterEach(async () => {
  for (const controller of controllers) await controller.dispose();
  controllers = [];
  rmSync(home, { recursive: true, force: true });
});

async function start(kind: 'vscode' | 'desktop', settings: Record<string, unknown> = {}) {
  const shell = new FakeShell(kind, home, [folderA, folderB], settings);
  const controller = new AppController(shell);
  controllers.push(controller);
  await controller.initialize();
  return { shell, controller };
}

/** A saved task in a folder's history, as the app writes it. */
async function saveTask(shell: FakeShell, folder: string, id: string, title: string) {
  const view = emptySession();
  applyEvent(view, { type: 'user_message', id: 'u1', text: title });
  const now = new Date().toISOString();
  await new FileTaskStore(shell.storage(folder).tasks).save({
    version: 1,
    id,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `<context>\n</context>\n${title}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ],
    subagentProfiles: [],
    usageByAgent: [],
    view,
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('desktop session list', () => {
  it('lists the tasks of every recent folder, with the task open now', async () => {
    const { shell, controller } = await start('desktop');
    await saveTask(shell, folderB, 'task-b1', 'Fix the beta build');
    await controller.handleMessage({ type: 'listSessions' });
    const sessions = shell.last('sessions');
    assert.ok(sessions, 'sessions were posted');
    assert.deepEqual(
      sessions.groups.map((g) => [g.name, g.tasks.map((t) => t.id)]),
      [
        ['alpha', []],
        ['beta', ['task-b1']],
      ],
    );
    assert.equal(sessions.taskId, shell.last('init')?.taskId, 'the open (unsaved) task is named');
  });

  it('is not sent to VS Code or to the classic desktop layout', async () => {
    for (const [kind, settings] of [['vscode', {}], ['desktop', { 'desktop.layout': 'classic' }]] as const) {
      const { shell, controller } = await start(kind, settings);
      await controller.handleMessage({ type: 'listSessions' });
      assert.equal(shell.last('sessions'), undefined, kind);
    }
  });

  it('opens a task of another recent folder by switching to that folder first', async () => {
    const { shell, controller } = await start('desktop');
    await saveTask(shell, folderB, 'task-b1', 'Fix the beta build');
    await controller.handleMessage({ type: 'openTask', id: 'task-b1', folder: folderB });
    assert.equal(shell.currentFolder()?.path, folderB);
    const init = shell.last('init');
    assert.equal(init?.taskId, 'task-b1');
    assert.equal(init?.config.folder, path.resolve(folderB));
    assert.equal(init?.session.items[0]?.kind, 'user');
  });

  it('never switches to a folder that is not a recent one', async () => {
    const { shell, controller } = await start('desktop');
    // Only a task opened or started shows: config updates from the start may still arrive.
    const shown = () => shell.posted.filter((m) => m.type === 'init' || m.type === 'sessions').length;
    const before = shown();
    await controller.handleMessage({ type: 'openTask', id: 'task-x', folder: path.join(home, 'elsewhere') });
    await controller.handleMessage({ type: 'newTask', folder: path.join(home, 'elsewhere') });
    assert.equal(shell.currentFolder()?.path, folderA);
    assert.equal(shown(), before, 'nothing happened');
  });

  it('starts a new session in another recent folder', async () => {
    const { shell, controller } = await start('desktop');
    await controller.handleMessage({ type: 'newTask', folder: folderB });
    assert.equal(shell.currentFolder()?.path, folderB);
  });

  it("deletes a task from another folder's history after asking", async () => {
    const { shell, controller } = await start('desktop');
    await saveTask(shell, folderB, 'task-b1', 'Fix the beta build');
    await controller.handleMessage({ type: 'deleteTask', id: 'task-b1', folder: folderB });
    assert.equal((await new FileTaskStore(shell.storage(folderB).tasks).list()).length, 1, 'kept: the user did not confirm');
    shell.answer = 'Delete';
    await controller.handleMessage({ type: 'deleteTask', id: 'task-b1', folder: folderB });
    assert.deepEqual(await new FileTaskStore(shell.storage(folderB).tasks).list(), []);
    assert.equal(shell.currentFolder()?.path, folderA, 'the open folder stays');
    assert.deepEqual(shell.last('sessions')?.groups[1].tasks, []);
  });
});

describe('session groups', () => {
  it('creates, fills, renames and removes groups, and hides sessions', async () => {
    const { shell, controller } = await start('desktop');
    await saveTask(shell, folderB, 'task-b1', 'Fix the beta build');
    // A name is asked in a dialog: the fake shell answers none, so nothing is created.
    await controller.handleMessage({ type: 'organizeSessions', op: 'createGroup', taskId: 'task-b1' });
    assert.deepEqual(shell.globalState.get('orka.sessionOrganizer'), undefined);

    shell.input = async () => 'Release work';
    await controller.handleMessage({ type: 'organizeSessions', op: 'createGroup', taskId: 'task-b1' });
    let organizer = shell.last('sessions')!.organizer;
    assert.equal(organizer.groups.length, 1);
    const id = organizer.groups[0].id;
    assert.deepEqual([organizer.groups[0].name, organizer.assigned['task-b1']], ['Release work', id]);

    shell.input = async () => '  Shipping  ';
    await controller.handleMessage({ type: 'organizeSessions', op: 'renameGroup', groupId: id });
    await controller.handleMessage({ type: 'organizeSessions', op: 'hide', taskId: 'task-b1', hidden: true });
    organizer = shell.last('sessions')!.organizer;
    assert.equal(organizer.groups[0].name, 'Shipping');
    assert.deepEqual(organizer.hidden, ['task-b1']);

    // Unknown groups and malformed ids from the UI change nothing.
    await controller.handleMessage({ type: 'organizeSessions', op: 'moveToGroup', taskId: 'task-b1', groupId: 'g-nope' });
    await controller.handleMessage({ type: 'organizeSessions', op: 'hide', taskId: '../etc', hidden: true });
    organizer = shell.last('sessions')!.organizer;
    assert.equal(organizer.assigned['task-b1'], id, 'still in its group');
    assert.deepEqual(organizer.hidden, ['task-b1']);

    await controller.handleMessage({ type: 'organizeSessions', op: 'moveToGroup', taskId: 'task-b1' });
    assert.equal(shell.last('sessions')!.organizer.assigned['task-b1'], undefined, 'taken out of the group');
    await controller.handleMessage({ type: 'organizeSessions', op: 'moveToGroup', taskId: 'task-b1', groupId: id });
    await controller.handleMessage({ type: 'organizeSessions', op: 'deleteGroup', groupId: id });
    organizer = shell.last('sessions')!.organizer;
    assert.deepEqual([organizer.groups, organizer.assigned], [[], {}], 'its sessions go back to their folders');

    // Deleting the session clears it from the hidden list.
    shell.answer = 'Delete';
    await controller.handleMessage({ type: 'deleteTask', id: 'task-b1', folder: folderB });
    assert.deepEqual(shell.last('sessions')!.organizer.hidden, []);
  });
});

describe('desktop appearance settings', () => {
  it('are offered and saved only in the desktop app', async () => {
    const vscode = await start('vscode');
    await vscode.controller.handleMessage({ type: 'setSetting', key: 'desktop.theme', value: 'dark' });
    assert.equal(vscode.shell.settings.isSet('desktop.theme'), false);
    assert.equal(vscode.shell.last('init')?.config.ui, undefined);

    const desktop = await start('desktop');
    assert.deepEqual(desktop.shell.last('init')?.config.ui, { layout: 'ide', theme: 'system' });
    await desktop.controller.handleMessage({ type: 'setSetting', key: 'desktop.theme', value: 'dark' });
    await desktop.controller.handleMessage({ type: 'setSetting', key: 'desktop.layout', value: 'sideways' });
    assert.equal(desktop.shell.settings.get('desktop.theme', ''), 'dark');
    assert.equal(desktop.shell.settings.isSet('desktop.layout'), false, 'invalid values are refused');
    await tick();
    assert.deepEqual(desktop.shell.last('config')?.config.ui, { layout: 'ide', theme: 'dark' });
  });
});

describe('Orka update check', () => {
  const realFetch = globalThis.fetch;
  let requests = 0;
  let tag = 'v99.0.0';

  beforeEach(() => {
    delete process.env.ORKA_NO_UPDATE_CHECK;
    requests = 0;
    tag = 'v99.0.0';
    globalThis.fetch = (async () => {
      requests++;
      return new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false }), { status: 200, headers: { etag: '"abc"' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('tells about a newer release once and opens its page on request', async () => {
    const { shell, controller } = await start('desktop');
    await tick();
    assert.equal(requests, 1, 'checked at start');
    const notice = shell.asked.find((a) => a.text.startsWith('Orka 99.0.0 is available'));
    assert.ok(notice, 'the user was told');
    assert.deepEqual(notice.actions, ['Download']);
    const url = 'https://github.com/Enophia-Studio/orka/releases/tag/v99.0.0';
    assert.deepEqual(shell.last('config')?.config.app.update, { version: '99.0.0', url });

    // Within a day nothing is asked again; a check on request is, without telling twice.
    await controller.checkAppUpdate();
    assert.equal(requests, 1);
    shell.answer = 'Download';
    await controller.handleMessage({ type: 'checkAppUpdate' });
    await tick();
    assert.equal(requests, 2);
    assert.deepEqual(shell.opened, [url]);
    await controller.handleMessage({ type: 'openRelease' });
    assert.deepEqual(shell.opened, [url, url]);
  });

  it('says so when Orka is up to date, and stays quiet in the background', async () => {
    tag = `v${VERSION}`;
    const { shell, controller } = await start('desktop');
    await tick();
    assert.equal(requests, 1);
    assert.equal(shell.asked.length, 0);
    await controller.handleMessage({ type: 'checkAppUpdate' });
    assert.ok(shell.asked.some((a) => a.text === `Orka is up to date (${VERSION}).`));
    assert.equal(shell.last('config')?.config.app.update, undefined);
  });

  it('says when a check got no answer instead of claiming Orka is up to date', async () => {
    globalThis.fetch = (async () => new Response('', { status: 403 })) as typeof fetch;
    const { shell, controller } = await start('desktop');
    await tick();
    assert.equal(shell.last('config')?.config.app.error, 'GitHub answered 403');
    assert.equal(shell.asked.length, 0, 'a background failure is not announced');
    await controller.handleMessage({ type: 'checkAppUpdate' });
    assert.ok(shell.asked.some((a) => a.text === 'Could not check for a new Orka version: GitHub answered 403'));
    // The next answer clears it.
    tag = `v${VERSION}`;
    globalThis.fetch = (async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 })) as typeof fetch;
    await controller.handleMessage({ type: 'checkAppUpdate' });
    assert.equal(shell.last('config')?.config.app.error, undefined);
  });

  it('can be turned off', async () => {
    await start('vscode', { 'updates.check': false });
    process.env.ORKA_NO_UPDATE_CHECK = '1';
    await start('desktop');
    await tick();
    assert.equal(requests, 0);
  });

  it('never opens a page it did not build itself', async () => {
    const { shell, controller } = await start('desktop', { 'updates.check': false });
    await shell.globalState.update('orka.appUpdate', { checkedAt: Date.now(), latest: '99.0.0', url: 'https://evil.example/orka.exe' });
    await controller.handleMessage({ type: 'openRelease' });
    assert.deepEqual(shell.opened, []);
  });
});
