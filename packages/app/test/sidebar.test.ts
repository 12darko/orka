import type { TaskSummary } from '@orka/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sessionListHtml, type SidebarView } from '../webview/ide/sidebar';

const task = (id: string, title: string): TaskSummary => ({ id, title, createdAt: '2026-10-30T10:00:00Z', updatedAt: new Date().toISOString(), requests: 1 });

const view = (patch: Partial<SidebarView> = {}): SidebarView => ({
  groups: [
    { folder: 'D:/work/alpha', name: 'alpha', tasks: [task('a1', 'Add a lobby'), task('a2', 'Fix the <img src=x onerror=alert(1)> bug')] },
    { folder: 'D:/work/beta', name: 'beta', tasks: [task('b1', 'Write tests')] },
  ],
  folder: 'D:/work/alpha',
  taskId: 'a1',
  draftTitle: '',
  running: false,
  query: '',
  ...patch,
});

describe('session list', () => {
  it('marks the open task and escapes what tasks are called', () => {
    const html = sessionListHtml(view());
    assert.match(html, /class="side-item current"[^]*?data-id="a1"/);
    assert.ok(!html.includes('<img'), 'titles are escaped');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.equal((html.match(/data-action="open-session"/g) ?? []).length, 3);
  });

  it('shows the open task as a draft until it is saved, with its run state', () => {
    const html = sessionListHtml(view({ taskId: 'new-1', draftTitle: 'Make the menu calmer', running: true }));
    assert.match(html, /side-item current draft running/);
    assert.ok(html.includes('Make the menu calmer'));
    assert.ok(html.includes('run-dot'));
  });

  it('filters by title, case-insensitively, and says when nothing matches', () => {
    const html = sessionListHtml(view({ query: 'TESTS' }));
    assert.ok(html.includes('Write tests'));
    assert.ok(!html.includes('Add a lobby'));
    assert.ok(!html.includes('>alpha<'), 'a folder without a match is left out');
    assert.match(sessionListHtml(view({ query: 'nothing like this' })), /No session matches\./);
  });

  it('asks for a folder when there is none', () => {
    assert.match(sessionListHtml(view({ groups: [], folder: undefined })), /Open a folder to start a session\./);
  });
});
