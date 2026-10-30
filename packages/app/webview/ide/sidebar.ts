// The desktop app's session list: the tasks of the recent project folders, newest first.
import type { TaskSummary } from '@orka/core';
import { t, tn } from '@orka/core/src/i18n';
import type { SessionGroup, SessionOrganizerView } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';
import { ago } from '../core/format';

export interface SidebarView {
  /** The recent folders with their newest tasks. */
  groups: SessionGroup[];
  /** The user's own groups and hidden sessions. */
  organizer: SessionOrganizerView;
  /** Folded sections: "group:<id>" or "folder:<path>". */
  collapsed: ReadonlySet<string>;
  showHidden: boolean;
  /** The folder the agent works in and the task open there. */
  folder?: string;
  taskId?: string;
  /** Title of the open task while it is not in the history yet (empty: a new task). */
  draftTitle: string;
  running: boolean;
  query: string;
}

/**
 * Head, search box and footer; the list and the theme switch are filled in separately. When the
 * sidebar is closed, only the rail of icons at the end shows.
 */
export function sidebarFrame(logo: string): string {
  const railButton = (action: string, glyph: string, label: string, keys?: string) =>
    `<button class="icon-btn" data-action="${action}" aria-label="${attr(label)}" title="${attr(keys ? `${label} (${keys})` : label)}">${icon(glyph)}</button>`;
  return `
    <div class="side-head">
      <img class="side-logo" src="${attr(logo)}" width="22" height="22" alt=""><strong>Orka</strong><span class="spacer"></span>
      ${railButton('toggle-sidebar', 'sidebar', t('Hide the sidebar'), 'Ctrl+B')}
    </div>
    <button class="side-new" data-action="new-session" title="${attr(`${t('New session')} (Ctrl+Alt+N)`)}"><span class="side-new-icon">${icon('plus')}</span><span>${escapeHtml(t('New session'))}</span></button>
    <div class="side-search-row">
      <label class="side-search">${icon('search')}<input id="side-search" type="search" placeholder="${attr(t('Search sessions'))}" aria-label="${attr(t('Search sessions'))}" spellcheck="false"></label>
      ${railButton('new-group', 'folderPlus', t('New group'))}
    </div>
    <nav class="side-list" id="side-list" aria-label="${attr(t('Sessions'))}"></nav>
    <div class="side-foot">
      <button class="side-link" data-action="open-folder">${icon('folder')}<span>${escapeHtml(t('Open folder…'))}</span></button>
      <div class="side-foot-row">
        <button class="side-link" data-action="open-settings">${icon('gear')}<span>${escapeHtml(t('Settings'))}</span></button>
        <span class="spacer"></span>
        <div class="theme-switch" id="theme-switch" role="group" aria-label="${attr(t('Theme'))}"></div>
      </div>
    </div>
    <div class="side-rail">
      ${railButton('toggle-sidebar', 'sidebar', t('Show the sidebar'), 'Ctrl+B')}
      <span class="rail-new">${railButton('new-session', 'plus', t('New session'), 'Ctrl+Alt+N')}</span>
      ${railButton('search-sessions', 'search', t('Search sessions'), 'Ctrl+K')}
      <span class="spacer"></span>
      ${railButton('open-folder', 'folder', t('Open folder…'))}
      ${railButton('open-settings', 'gear', t('Settings'))}
    </div>`;
}

export function themeSwitchHtml(theme: 'system' | 'light' | 'dark'): string {
  const options: Array<[typeof theme, string, string]> = [
    ['system', 'monitor', t('Follow the system')],
    ['light', 'sun', t('Light')],
    ['dark', 'moon', t('Dark')],
  ];
  return options
    .map(
      ([value, glyph, label]) =>
        `<button class="${value === theme ? 'on' : ''}" data-action="set-setting" data-key="desktop.theme" data-value="${value}" aria-pressed="${value === theme}" aria-label="${attr(label)}" title="${attr(label)}">${icon(glyph)}</button>`,
    )
    .join('');
}

interface Listed {
  task: TaskSummary;
  folder: string;
  folderName: string;
}

/**
 * The list: the user's own groups first, then each recent folder with its other sessions, then (on
 * request) the hidden ones. Sections fold away; a search shows every match, folded or not.
 */
export function sessionListHtml(v: SidebarView): string {
  const query = v.query.trim().toLowerCase();
  const matches = (title: string) => !query || title.toLowerCase().includes(query);
  const hidden = new Set(v.organizer.hidden);
  const all: Listed[] = v.groups.flatMap((g) => g.tasks.map((task) => ({ task, folder: g.folder, folderName: g.name })));
  const row = (item: Listed, meta?: string) => {
    const open = !!v.folder && samePath(item.folder, v.folder) && item.task.id === v.taskId;
    return `<div class="side-item${open ? ' current' : ''}${open && v.running ? ' running' : ''}">
      <button class="side-open" data-action="open-session" data-id="${attr(item.task.id)}" data-folder="${attr(item.folder)}" title="${attr(`${item.task.title}\n${item.folderName} · ${ago(item.task.updatedAt)}`)}"${open ? ' aria-current="true"' : ''}>
        <span class="side-title">${open && v.running ? '<span class="run-dot"></span>' : ''}<span class="ellipsis">${escapeHtml(item.task.title)}</span>${meta ? `<span class="side-meta">${escapeHtml(meta)}</span>` : ''}</span></button>
      <button class="icon-btn side-more" data-action="session-menu" data-id="${attr(item.task.id)}" data-folder="${attr(item.folder)}" aria-haspopup="menu" aria-label="${attr(t('More for this session'))}" title="${attr(t('More for this session'))}">${icon('more')}</button>
    </div>`;
  };
  /** A foldable section; `buttons` sit at the end of its heading. */
  const section = (key: string, head: string, rows: string[], cls: string, buttons: string) => {
    const folded = v.collapsed.has(key) && !query;
    return `<div class="side-group${cls}${folded ? ' folded' : ''}">
      <div class="side-group-head"><button class="side-fold" data-action="toggle-section" data-key="${attr(key)}" aria-expanded="${!folded}">${icon('chevron', 'fold-chevron')}${head}</button>${buttons}</div>
      ${folded ? '' : rows.join('')}</div>`;
  };

  const out: string[] = [];
  for (const group of v.organizer.groups) {
    const items = all.filter((i) => v.organizer.assigned[i.task.id] === group.id && !hidden.has(i.task.id) && matches(i.task.title));
    if (query && !items.length) continue;
    const head = `<span class="ellipsis">${escapeHtml(group.name)}</span><span class="side-count">${items.length}</span>`;
    const actions = `<span class="side-group-actions">
        <button class="icon-btn" data-action="group-rename" data-group="${attr(group.id)}" aria-label="${attr(t('Rename group'))}" title="${attr(t('Rename group'))}">${icon('edit')}</button>
        <button class="icon-btn" data-action="group-delete" data-group="${attr(group.id)}" aria-label="${attr(t('Remove the group (its sessions stay)'))}" title="${attr(t('Remove the group (its sessions stay)'))}">${icon('x')}</button></span>`;
    const rows = items.length ? items.map((i) => row(i, i.folderName)) : [`<div class="side-empty">${escapeHtml(t('Move sessions here with their … menu.'))}</div>`];
    out.push(section(`group:${group.id}`, head, rows, ' user-group', actions));
  }

  for (const folder of v.groups) {
    const current = !!v.folder && samePath(folder.folder, v.folder);
    const items = all.filter((i) => i.folder === folder.folder && !v.organizer.assigned[i.task.id] && !hidden.has(i.task.id) && matches(i.task.title));
    // The open task is listed once it is saved; until then it shows as a draft at the top.
    const draft = current && !folder.tasks.some((task) => task.id === v.taskId) && matches(v.draftTitle || t('New session'));
    if (query && !items.length && !draft) continue;
    const rows = items.map((i) => row(i));
    if (draft) {
      rows.unshift(`<div class="side-item current draft${v.running ? ' running' : ''}"><span class="side-open" aria-current="true">
        <span class="side-title">${v.running ? '<span class="run-dot"></span>' : ''}<span class="ellipsis">${escapeHtml(v.draftTitle || t('New session'))}</span></span></span></div>`);
    }
    if (!rows.length) rows.push(`<div class="side-empty">${escapeHtml(t('No sessions yet.'))}</div>`);
    const head = `${icon('folder')}<span class="ellipsis" title="${attr(folder.folder)}">${escapeHtml(folder.name)}</span>`;
    const add = `<button class="icon-btn" data-action="new-session" data-folder="${attr(folder.folder)}" aria-label="${attr(t('New session in {folder}', { folder: folder.name }))}" title="${attr(t('New session in {folder}', { folder: folder.name }))}">${icon('plus')}</button>`;
    out.push(section(`folder:${folder.folder}`, head, rows, current ? ' current' : '', add));
  }

  const hiddenItems = all.filter((i) => hidden.has(i.task.id) && matches(i.task.title));
  if (hiddenItems.length) {
    out.push(`<button class="side-hidden-toggle" data-action="toggle-hidden" aria-expanded="${v.showHidden}">${icon(v.showHidden ? 'eye' : 'ban')}<span>${escapeHtml(
      v.showHidden ? t('Hide the hidden sessions') : tn('{n} hidden session', '{n} hidden sessions', hiddenItems.length),
    )}</span></button>`);
    if (v.showHidden) out.push(`<div class="side-group hidden-group">${hiddenItems.map((i) => row(i, i.folderName)).join('')}</div>`);
  }

  if (out.length) return out.join('');
  return `<div class="side-empty">${escapeHtml(query ? t('No session matches.') : t('Open a folder to start a session.'))}</div>`;
}

/** The … menu of a session: move it to a group, out of it, hide or show it, delete it. */
export function sessionMenuHtml(taskId: string, folder: string, organizer: SessionOrganizerView): string {
  const inGroup = organizer.assigned[taskId];
  const hidden = organizer.hidden.includes(taskId);
  const item = (action: string, glyph: string, label: string, extra = '', cls = '') =>
    `<button class="menu-item${cls}" role="menuitem" data-action="${action}" data-id="${attr(taskId)}" data-folder="${attr(folder)}"${extra}>${icon(glyph)}<span>${escapeHtml(label)}</span></button>`;
  const groups = organizer.groups
    .filter((g) => g.id !== inGroup)
    .map((g) => item('session-to-group', 'folder', g.name, ` data-group="${attr(g.id)}"`))
    .join('');
  return `${organizer.groups.length > (inGroup ? 1 : 0) ? `<div class="menu-label">${escapeHtml(t('Move to group'))}</div>${groups}` : ''}
    ${item('session-new-group', 'plus', t('New group…'))}
    ${inGroup ? item('session-ungroup', 'undo', t('Take out of the group')) : ''}
    <hr>
    ${item('session-hide', hidden ? 'eye' : 'ban', hidden ? t('Show in the list') : t('Hide from the list'), ` data-hidden="${!hidden}"`)}
    ${item('delete-session', 'delete', t('Delete'), '', ' danger')}`;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
