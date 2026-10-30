// The desktop app's session list: the tasks of the recent project folders, newest first.
import { t } from '@orka/core/src/i18n';
import type { SessionGroup } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';
import { ago } from '../core/format';

export interface SidebarView {
  groups: SessionGroup[];
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
    <label class="side-search">${icon('search')}<input id="side-search" type="search" placeholder="${attr(t('Search sessions'))}" aria-label="${attr(t('Search sessions'))}" spellcheck="false"></label>
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

export function sessionListHtml(v: SidebarView): string {
  const query = v.query.trim().toLowerCase();
  const matches = (title: string) => !query || title.toLowerCase().includes(query);
  const groups = v.groups
    .map((group) => {
      const current = !!v.folder && samePath(group.folder, v.folder);
      const tasks = group.tasks.filter((task) => matches(task.title));
      // The open task is listed once it is saved; until then it shows as a draft at the top.
      const draft = current && !group.tasks.some((task) => task.id === v.taskId) && matches(v.draftTitle || t('New session'));
      if (query && !tasks.length && !draft) return '';
      const rows = tasks.map((task) => {
        const open = current && task.id === v.taskId;
        return `<div class="side-item${open ? ' current' : ''}${open && v.running ? ' running' : ''}">
          <button class="side-open" data-action="open-session" data-id="${attr(task.id)}" data-folder="${attr(group.folder)}" title="${attr(`${task.title}\n${ago(task.updatedAt)}`)}"${open ? ' aria-current="true"' : ''}>
            <span class="side-title">${open && v.running ? '<span class="run-dot"></span>' : ''}<span class="ellipsis">${escapeHtml(task.title)}</span></span></button>
          <button class="icon-btn side-del" data-action="delete-session" data-id="${attr(task.id)}" data-folder="${attr(group.folder)}" aria-label="${attr(t('Delete task'))}" title="${attr(t('Delete'))}">${icon('delete')}</button>
        </div>`;
      });
      if (draft) {
        rows.unshift(`<div class="side-item current draft${v.running ? ' running' : ''}"><span class="side-open" aria-current="true">
          <span class="side-title">${v.running ? '<span class="run-dot"></span>' : ''}<span class="ellipsis">${escapeHtml(v.draftTitle || t('New session'))}</span></span></span></div>`);
      }
      return `<div class="side-group${current ? ' current' : ''}">
        <div class="side-group-head" title="${attr(group.folder)}">${icon('folder')}<span class="ellipsis">${escapeHtml(group.name)}</span><span class="spacer"></span>
          <button class="icon-btn" data-action="new-session" data-folder="${attr(group.folder)}" aria-label="${attr(t('New session in {folder}', { folder: group.name }))}" title="${attr(t('New session in {folder}', { folder: group.name }))}">${icon('plus')}</button></div>
        ${rows.join('') || `<div class="side-empty">${escapeHtml(t('No sessions yet.'))}</div>`}
      </div>`;
    })
    .join('');
  if (groups) return groups;
  return `<div class="side-empty">${escapeHtml(query ? t('No session matches.') : t('Open a folder to start a session.'))}</div>`;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
