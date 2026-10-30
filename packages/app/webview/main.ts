import type { AgentEvent, AgentPhase, AgentUsage, FileChange, ModelInfo, Plan, SessionView, SubagentView, TaskSummary, ToolCallView, TranscriptItem, Usage } from '@orka/core';
import { getLocale, setLocale, t, tn } from '@orka/core/src/i18n';
import { applyEvent, emptySession } from '@orka/core/src/ui/transcript';
import { estimateCost } from '@orka/core/src/usage/pricing';
import orkaLogo from '../media/orka-logo.svg';
import type { AgentView, ConfigView, HunkView, ImageAttachment, McpServerView, ProviderView, SessionGroup, SettingsTab, SettingsView, SkillView, ToWebview } from '../src/protocol';
import { post, saveUiState, uiState } from './core/bridge';
import { attr, escapeHtml, icon, renderMarkdown } from './core/dom';
import { ago, applyWidths, fmt } from './core/format';
import { answerDialog, closeDialog, modalOpen, showDialog } from './features/dialogs';
import { appSkeleton, layout } from './ide/layout';
import { sessionListHtml, sidebarFrame, themeSwitchHtml } from './ide/sidebar';

let session: SessionView = emptySession();
let config: ConfigView | undefined;
const ui: {
  planCollapsed: boolean;
  agentsOpen: boolean;
  usageOpen: boolean;
  view: 'chat' | 'settings' | 'history';
  tab: SettingsTab;
  /** Changed files whose hunks are shown, with the hunks last received. */
  hunks: Map<string, HunkView[] | undefined>;
  /** Desktop IDE layout: closed side panels, and the session list with its filter. */
  sidebarClosed: boolean;
  asideClosed: boolean;
  sessions: SessionGroup[];
  sessionQuery: string;
  /** The task shown, as the app reported it with the session. */
  taskId?: string;
} = {
  planCollapsed: false,
  agentsOpen: false,
  usageOpen: false,
  view: 'chat',
  tab: 'agents',
  hunks: new Map(),
  sidebarClosed: !!uiState().sidebarClosed,
  asideClosed: !!uiState().asideClosed,
  sessions: [],
  sessionQuery: '',
};

// ------------------------------------------------------------------ icons

function toolIcon(call: ToolCallView): string {
  if (call.name === 'run_subagent') return 'agent';
  if (call.name === 'update_plan') return 'plan';
  if (call.name === 'load_skill') return 'skill';
  if (call.name === 'web_fetch' || call.name === 'open_browser' || call.name === 'browser' || call.category === 'network') return 'globe';
  if (call.name.startsWith('git_') || call.category === 'git') return 'git';
  if (call.name === 'search_code' || call.name === 'search_files') return 'search';
  if (call.category === 'command') return 'command';
  if (call.category === 'delete') return 'delete';
  if (call.category === 'edit') return 'edit';
  return 'read';
}

// ------------------------------------------------------------------ layout

const app = document.getElementById('app')!;
app.innerHTML = appSkeleton();

const el = {
  topbar: document.getElementById('topbar')!,
  agents: document.getElementById('agents-panel')!,
  usage: document.getElementById('usage-panel')!,
  plan: document.getElementById('plan-panel')!,
  changes: document.getElementById('changes-panel')!,
  transcript: document.getElementById('transcript')!,
  settings: document.getElementById('settings-view')!,
  history: document.getElementById('history-view')!,
  composer: document.getElementById('composer')!,
  suggest: document.getElementById('suggest')!,
  chips: document.getElementById('chips')!,
  input: document.getElementById('input') as HTMLTextAreaElement,
  send: document.getElementById('send') as HTMLButtonElement,
  meta: document.getElementById('meta')!,
  /** Only in the IDE layout. */
  sidebar: document.getElementById('sidebar'),
  aside: document.getElementById('aside'),
  mainCol: document.getElementById('main-col'),
  composerMode: document.getElementById('composer-mode'),
  composerAgent: document.getElementById('composer-agent'),
  composerMenu: document.getElementById('composer-menu'),
  starters: document.getElementById('starters'),
  imageInput: document.getElementById('image-input') as HTMLInputElement | null,
};

el.input.value = uiState().draft ?? '';

/** Texts of the static layout, re-applied when the language changes. */
function renderStatic(): void {
  document.documentElement.lang = getLocale();
  el.input.placeholder = t('Describe a task…  / commands and skills, @ files, paste or drop images');
  el.suggest.setAttribute('aria-label', t('Suggestions'));
  el.meta.title = t('Token usage per agent');
  // Built again only for another language: a full render must not take the search box from under the cursor.
  if (el.sidebar && el.sidebar.dataset.locale !== getLocale()) {
    el.sidebar.innerHTML = sidebarFrame(LOGO);
    el.sidebar.dataset.locale = getLocale();
    (document.getElementById('side-search') as HTMLInputElement).value = ui.sessionQuery;
  }
  const add = el.composer.querySelector<HTMLElement>('.composer-add');
  if (add) {
    add.innerHTML = icon('plus');
    add.setAttribute('aria-label', t('Add files, images or a skill'));
    add.title = t('Add files, images or a skill');
  }
  const toBottom = document.getElementById('to-bottom');
  if (toBottom) {
    toBottom.setAttribute('aria-label', t('Jump to the newest'));
    toBottom.title = t('Jump to the newest');
  }
}

// ------------------------------------------------------------------ IDE layout (desktop)

const LOGO = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(orkaLogo)}`;

/** The open task's first request, shortened like the titles in the history. */
function sessionTitle(): string {
  const first = session.items.find((i) => i.kind === 'user');
  const text = first && first.kind === 'user' ? first.text.replace(/\s+/g, ' ').trim() : '';
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

function renderSidebar(): void {
  if (!el.sidebar) return;
  // Closed, it is a narrow rail of icons.
  el.sidebar.classList.toggle('collapsed', ui.sidebarClosed);
  const list = document.getElementById('side-list');
  if (list) {
    list.innerHTML = sessionListHtml({
      groups: ui.sessions,
      folder: config?.folder,
      taskId: ui.taskId,
      draftTitle: sessionTitle(),
      running: session.running,
      query: ui.sessionQuery,
    });
  }
  const themes = document.getElementById('theme-switch');
  if (themes) themes.innerHTML = config?.ui ? themeSwitchHtml(config.ui.theme) : '';
}

/** The plan and the changes have their own panel on the right; it shows while there is either. */
function asideContent(): boolean {
  return !!session.plan?.steps.length || session.changes.length > 0;
}

let asideHadContent = false;

function updateAside(): void {
  if (!el.aside) return;
  el.aside.hidden = ui.view !== 'chat' || ui.asideClosed || !asideContent();
  // The top bar offers to show or hide it once there is something in it.
  if (asideContent() !== asideHadContent) {
    asideHadContent = asideContent();
    renderTopbar();
  }
}

function toggleSidebar(): void {
  ui.sidebarClosed = !ui.sidebarClosed;
  saveUiState({ sidebarClosed: ui.sidebarClosed });
  renderSidebar();
}

/** Ctrl+K or the rail's search button: the session list, with the cursor in its search box. */
function searchSessions(): void {
  if (ui.sidebarClosed) toggleSidebar();
  const search = document.getElementById('side-search') as HTMLInputElement | null;
  search?.focus();
  search?.select();
}

/** The "to the newest" button shows while the conversation is scrolled up. */
function updateToBottom(): void {
  const button = document.getElementById('to-bottom');
  if (button) button.hidden = ui.view !== 'chat' || !session.items.length || nearBottom();
}

function toggleAside(): void {
  ui.asideClosed = !ui.asideClosed;
  saveUiState({ asideClosed: ui.asideClosed });
  updateAside();
  renderTopbar();
}

/** IDE layout: the permission mode and the main agent's model sit in the message box. */
function renderComposerTools(): void {
  if (!el.composerMode || !el.composerAgent) return;
  const main = config?.main.effective;
  const warn = main && !providerView(main.provider)?.ready;
  el.composerMode.innerHTML = modeSelect();
  el.composerAgent.innerHTML = main
    ? `<button class="agent-btn${ui.agentsOpen ? ' open' : ''}${warn ? ' warn' : ''}" data-action="toggle-agents" aria-expanded="${ui.agentsOpen}" title="${attr(t('Agents: providers and models'))}">${icon('agent')}<span>${escapeHtml(shortModel(main.provider, main.model))}</span>${icon('chevron', 'chev')}</button>`
    : '';
}

/** The + menu of the message box: attach a file, add an image, use a skill. */
function renderComposerMenu(open: boolean): void {
  if (!el.composerMenu) return;
  el.composerMenu.hidden = !open;
  el.composer.querySelector('.composer-add')?.setAttribute('aria-expanded', String(open));
  if (!open) return;
  const item = (action: string, glyph: string, label: string, hint: string) =>
    `<button class="menu-item" role="menuitem" data-action="${action}">${icon(glyph)}<span>${escapeHtml(label)}</span><span class="menu-hint">${escapeHtml(hint)}</span></button>`;
  el.composerMenu.innerHTML =
    item('attach-file', 'read', t('Attach a file'), '@') + item('attach-image', 'image', t('Add an image'), t('or paste')) + item('insert-command', 'skill', t('Use a skill or command'), '/');
  el.composerMenu.querySelector<HTMLElement>('.menu-item')?.focus();
}

/** Put text at the cursor in the message box (and show what it suggests). */
function insertAtCursor(text: string): void {
  const { selectionStart: start, selectionEnd: end, value } = el.input;
  const before = value.slice(0, start);
  const spaced = text === '@' && before && !/\s$/.test(before) ? ` ${text}` : text;
  el.input.value = before + spaced + value.slice(end);
  el.input.selectionStart = el.input.selectionEnd = start + spaced.length;
  el.input.focus();
  saveUiState({ draft: el.input.value });
  autoGrow();
  updateSuggestions();
}

/** A new session: the greeting and the message box in the middle, with suggestions under it. */
function renderStarters(): void {
  if (!el.mainCol || !el.starters) return;
  const fresh = ui.view === 'chat' && !session.items.length && !!config?.workspaceOpen;
  el.mainCol.classList.toggle('is-empty', ui.view === 'chat' && !session.items.length);
  el.starters.hidden = !fresh;
  if (!fresh) return;
  el.starters.innerHTML = starterPrompts()
    .map((text) => `<button class="starter" data-action="example" data-text="${attr(text)}">${escapeHtml(text)}</button>`)
    .join('');
}

function starterPrompts(): string[] {
  return [
    t('Explain the architecture of this project and where the main entry points are.'),
    t('Find the cause of the failing tests and fix it.'),
    t('Add input validation to the signup form and cover it with tests.'),
  ];
}

if (el.imageInput) {
  el.imageInput.addEventListener('change', () => {
    const files = [...(el.imageInput!.files ?? [])];
    el.imageInput!.value = '';
    if (files.length) void addImages(files);
  });
}

/** The desktop app's theme setting; the layout is chosen as the page loads, so a change reloads it once. */
function applyAppearance(): void {
  if (!config?.ui) return;
  document.documentElement.dataset.theme = config.ui.theme;
  if ((config.ui.layout === 'ide') !== (layout === 'ide')) reloadFor(config.ui.layout);
}

/**
 * Reload for a layout, unless this page already reloaded for that same layout moments ago and
 * still did not get it (then the page and the setting disagree, and reloading again would loop).
 */
function reloadFor(target: string): void {
  try {
    const last: unknown = JSON.parse(sessionStorage.getItem('orka.reload') ?? 'null');
    const previous = last && typeof last === 'object' ? (last as { target?: unknown; at?: unknown }) : {};
    if (previous.target === target && Date.now() - Number(previous.at) < 10_000) return;
    sessionStorage.setItem('orka.reload', JSON.stringify({ target, at: Date.now() }));
  } catch {
    return;
  }
  location.reload();
}

if (layout === 'ide') {
  document.addEventListener('keydown', (e) => {
    // An Escape that closed a dialog is used up.
    if (e.key === 'Escape' && !e.defaultPrevented && !modalOpen()) {
      if (el.composerMenu && !el.composerMenu.hidden) {
        renderComposerMenu(false);
        el.input.focus();
      } else if (ui.agentsOpen) {
        ui.agentsOpen = false;
        renderAgentsPanel();
      }
      return;
    }
    if (modalOpen() || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
    // Physical keys: Ctrl+Alt is AltGr on many keyboards, which changes e.key.
    if (e.code === 'KeyB') {
      e.preventDefault();
      if (e.altKey) toggleAside();
      else toggleSidebar();
    } else if (e.code === 'KeyK' && !e.altKey) {
      e.preventDefault();
      searchSessions();
    } else if (e.code === 'KeyN' && e.altKey) {
      e.preventDefault();
      post({ type: 'newTask' });
    }
  });
  document.addEventListener('input', (e) => {
    const target = e.target as HTMLElement;
    if (target.id !== 'side-search') return;
    ui.sessionQuery = (target as HTMLInputElement).value;
    renderSidebar();
  });
}

// ------------------------------------------------------------------ composer: commands, skills, @files

interface Command {
  name: string;
  detail: string;
  arg?: string;
  /** A skill invoked for this request instead of a built-in command. */
  skill?: boolean;
}

function builtinCommands(): Command[] {
  return [
    { name: 'new', detail: t('Start a new task (this one is kept in the history)') },
    { name: 'compact', detail: t('Condense the conversation into a handoff note to free context') },
    { name: 'history', detail: t('Open earlier tasks') },
    { name: 'review', detail: t('Have the review sub-agent check every change of this task'), arg: t('[focus]') },
    { name: 'plan', detail: t('Plan first and wait for your go-ahead'), arg: t('<task>') },
    { name: 'explore', detail: t('Investigate with parallel explore sub-agents'), arg: t('<question>') },
    { name: 'agents', detail: t('Choose providers and models for each agent') },
    { name: 'skills', detail: t('Manage skills') },
    { name: 'usage', detail: t('Token usage per agent') },
    { name: 'settings', detail: t('Open the settings') },
    { name: 'help', detail: t('List the commands') },
  ];
}

/** Built-in commands, then every enabled skill as "/<skill> <request>". */
function commands(): Command[] {
  const builtin = builtinCommands();
  const skills = (config?.skillsEnabled ? config.skills : [])
    .filter((s) => s.enabled && !builtin.some((c) => c.name === s.name))
    .map((s) => ({ name: s.name, detail: s.description, arg: t('<request>'), skill: true }));
  return [...builtin, ...skills];
}

const composer = {
  attachments: [] as string[],
  images: [] as ImageAttachment[],
  suggest: undefined as undefined | { kind: 'command' | 'file'; items: Array<{ value: string; label: string; detail?: string; skill?: boolean }>; index: number; query: string },
  fileTimer: 0,
};

function renderChips(): void {
  el.chips.hidden = !composer.attachments.length && !composer.images.length;
  el.chips.innerHTML =
    composer.images
      .map(
        (img, i) => `<span class="chip image-chip" title="${attr(img.name)}">${img.thumb ? `<img src="${attr(img.thumb)}" alt="">` : icon('image')}
        <button class="chip-x" data-action="remove-image" data-index="${i}" aria-label="${attr(t('Remove {file}', { file: img.name }))}">${icon('x')}</button></span>`,
      )
      .join('') +
    composer.attachments
      .map(
        (f) => `<span class="chip">${icon('read')}<span class="ellipsis" title="${attr(f)}">${escapeHtml(f)}</span>
        <button class="chip-x" data-action="remove-attachment" data-path="${attr(f)}" aria-label="${attr(t('Remove {file}', { file: f }))}">${icon('x')}</button></span>`,
      )
      .join('');
}

// ------------------------------------------------------------------ composer: images

const MAX_IMAGES = 5;
/** Long edge sent to the model: larger images cost more tokens without helping it see more. */
const MAX_IMAGE_EDGE = 1568;

async function addImages(files: File[]): Promise<void> {
  const room = MAX_IMAGES - composer.images.length;
  if (room <= 0) {
    onEvent({ type: 'notice', level: 'warning', message: t('At most {n} images per message.', { n: MAX_IMAGES }) });
    return;
  }
  for (const file of files.filter((f) => f.type.startsWith('image/')).slice(0, room)) {
    try {
      const bitmap = await createImageBitmap(file);
      const full = encodeImage(bitmap, MAX_IMAGE_EDGE);
      const thumb = encodeImage(bitmap, 160, 'image/jpeg');
      bitmap.close();
      composer.images.push({ name: file.name || t('Pasted image'), mediaType: full.mediaType, data: full.data, thumb: thumb.url });
    } catch {
      onEvent({ type: 'notice', level: 'warning', message: t('Could not read the image {file}.', { file: file.name || '' }) });
    }
  }
  renderChips();
  el.input.focus();
}

/** Scale down to `edge` and encode: PNG keeps screenshots sharp; JPEG when PNG would be large. */
function encodeImage(bitmap: ImageBitmap, edge: number, force?: 'image/jpeg'): { mediaType: ImageAttachment['mediaType']; data: string; url: string } {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d')!;
  if (force === 'image/jpeg') {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
  }
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let url = force ? canvas.toDataURL(force, 0.7) : canvas.toDataURL('image/png');
  if (!force && url.length > 1_500_000) url = canvas.toDataURL('image/jpeg', 0.85);
  const mediaType = url.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
  return { mediaType, data: url.slice(url.indexOf(',') + 1), url };
}

el.input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((f): f is File => !!f);
  if (!files.length) return;
  e.preventDefault();
  void addImages(files);
});
el.composer.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) {
    e.preventDefault();
    el.composer.classList.add('drop');
  }
});
el.composer.addEventListener('dragleave', () => el.composer.classList.remove('drop'));
el.composer.addEventListener('drop', (e) => {
  el.composer.classList.remove('drop');
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  void addImages(files);
});

function renderSuggest(): void {
  const s = composer.suggest;
  el.suggest.hidden = !s || !s.items.length;
  if (!s || !s.items.length) return;
  el.suggest.innerHTML = s.items
    .map(
      (item, i) => `<button class="suggest-item${i === s.index ? ' on' : ''}${item.skill ? ' skill' : ''}" role="option" aria-selected="${i === s.index}" data-action="pick-suggestion" data-index="${i}">
        ${item.skill ? icon('skill', 'sub') : ''}<span class="suggest-label ${s.kind === 'file' ? 'mono' : ''}">${escapeHtml(item.label)}</span>${item.detail ? `<span class="suggest-detail ellipsis">${escapeHtml(item.detail)}</span>` : ''}</button>`,
    )
    .join('');
}

/** The "@word" being typed at the cursor, if any. */
function mentionAtCursor(): { start: number; query: string } | undefined {
  const upto = el.input.value.slice(0, el.input.selectionStart);
  const m = /(^|\s)@([^\s@]*)$/.exec(upto);
  return m ? { start: upto.length - m[2].length - 1, query: m[2] } : undefined;
}

function updateSuggestions(): void {
  const value = el.input.value;
  const command = /^\/([\w-]*)$/.exec(value.trimStart());
  if (command) {
    const q = command[1].toLowerCase();
    const items = commands()
      .filter((c) => c.name.startsWith(q))
      .map((c) => ({ value: c.name, label: `/${c.name}${c.arg ? ` ${c.arg}` : ''}`, detail: c.detail, skill: c.skill }));
    composer.suggest = { kind: 'command', items, index: 0, query: q };
    renderSuggest();
    return;
  }
  const mention = mentionAtCursor();
  if (mention && mention.query.length >= 1) {
    clearTimeout(composer.fileTimer);
    composer.fileTimer = window.setTimeout(() => post({ type: 'searchFiles', query: mention.query }), 120);
    if (composer.suggest?.kind !== 'file') composer.suggest = { kind: 'file', items: [], index: 0, query: mention.query };
    else composer.suggest.query = mention.query;
    return;
  }
  composer.suggest = undefined;
  renderSuggest();
}

function pickSuggestion(index: number): void {
  const s = composer.suggest;
  const item = s?.items[index];
  if (!s || !item) return;
  if (s.kind === 'command') {
    const cmd = commands().find((c) => c.name === item.value)!;
    el.input.value = `/${cmd.name}${cmd.arg ? ' ' : ''}`;
    composer.suggest = undefined;
    renderSuggest();
    if (!cmd.arg) submit();
  } else {
    const mention = mentionAtCursor();
    if (mention) {
      el.input.value = el.input.value.slice(0, mention.start) + el.input.value.slice(el.input.selectionStart);
      el.input.selectionStart = el.input.selectionEnd = mention.start;
    }
    if (!composer.attachments.includes(item.value)) composer.attachments.push(item.value);
    composer.suggest = undefined;
    renderSuggest();
    renderChips();
  }
  el.input.focus();
  autoGrow();
}

/** Slash commands and skills; returns true when the input was handled. */
function runCommand(text: string): boolean {
  const m = /^\/([\w-]+)\s*([\s\S]*)$/.exec(text);
  if (!m) return false;
  const [, raw, arg] = m;
  const name = raw.toLowerCase();
  const rest = arg.trim();
  switch (name) {
    case 'new':
      post({ type: 'newTask' });
      return true;
    case 'compact':
      post({ type: 'compact' });
      return true;
    case 'history':
      openHistory();
      return true;
    case 'agents':
      ui.view = 'chat';
      ui.agentsOpen = true;
      renderView();
      return true;
    case 'skills':
      ui.view = 'settings';
      ui.tab = 'skills';
      post({ type: 'reloadSkills' });
      renderView();
      return true;
    case 'usage':
      ui.usageOpen = true;
      renderUsage();
      return true;
    case 'settings':
      ui.view = 'settings';
      renderView();
      return true;
    case 'help':
      onEvent({
        type: 'notice',
        level: 'info',
        message: t('Commands: {list}. Skills: {skills}. Type @ to attach files.', {
          list: builtinCommands()
            .map((c) => `/${c.name}${c.arg ? ` ${c.arg}` : ''}`)
            .join('  '),
          skills: commands()
            .filter((c) => c.skill)
            .map((c) => `/${c.name}`)
            .join('  ') || '-',
        }),
      });
      return true;
    case 'review':
      send(`Use the review sub-agent to review every change made in this task${rest ? `, focusing on: ${rest}` : ''}. Then summarize its findings and fix anything important.`);
      return true;
    case 'plan':
      if (!rest) return false;
      send(`Plan first: explore as needed, then propose a plan with update_plan and wait for my go-ahead before changing any files.\n\nTask: ${rest}`);
      return true;
    case 'explore':
      if (!rest) return false;
      send(`Use explore sub-agents to answer this - split it into independent parts and run them in parallel where that helps, then combine the findings:\n\n${rest}`);
      return true;
    default: {
      const skill = config?.skills.find((s) => s.name === name);
      if (!skill || !rest) return false;
      send(rest, [skill.name]);
      return true;
    }
  }
}

function send(text: string, skills?: string[]): void {
  post({
    type: 'send',
    text,
    files: composer.attachments.length ? [...composer.attachments] : undefined,
    skills,
    images: composer.images.length ? [...composer.images] : undefined,
  });
  composer.attachments = [];
  composer.images = [];
  renderChips();
}

function submit(): void {
  if (session.running) {
    post({ type: 'stop' });
    return;
  }
  const text = el.input.value.trim();
  if (!text) return;
  if (!runCommand(text)) send(text);
  el.input.value = '';
  composer.suggest = undefined;
  renderSuggest();
  saveUiState({ draft: '' });
  autoGrow();
}

el.send.addEventListener('click', submit);
el.input.addEventListener('keydown', (e) => {
  const s = composer.suggest;
  if (s && s.items.length && !el.suggest.hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      s.index = (s.index + (e.key === 'ArrowDown' ? 1 : s.items.length - 1)) % s.items.length;
      renderSuggest();
      return;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      pickSuggestion(s.index);
      return;
    }
    if (e.key === 'Escape') {
      composer.suggest = undefined;
      renderSuggest();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!session.running) submit();
  }
});
el.input.addEventListener('input', () => {
  saveUiState({ draft: el.input.value });
  autoGrow();
  updateSuggestions();
});
el.input.addEventListener('blur', () =>
  setTimeout(() => {
    if (document.activeElement !== el.input) {
      composer.suggest = undefined;
      renderSuggest();
    }
  }, 150),
);

function autoGrow(): void {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 240)}px`;
}

// ------------------------------------------------------------------ interaction

document.addEventListener('click', (e) => {
  // IDE layout: the + menu and the agents panel open over the message box and close on a click elsewhere.
  const clicked = e.target as HTMLElement;
  if (el.composerMenu && !el.composerMenu.hidden && !clicked.closest('#composer-menu, .composer-add')) renderComposerMenu(false);
  if (layout === 'ide' && ui.agentsOpen && clicked.isConnected && !clicked.closest('#agents-panel, .agent-btn, .modal-backdrop, .dialogs')) {
    ui.agentsOpen = false;
    renderAgentsPanel();
  }
  const target = clicked.closest<HTMLElement>('[data-action]');
  if (!target || target.tagName === 'SELECT' || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'button')) return;
  // A button in a tool line (e.g. "diff") does its own thing without opening the line.
  if (target.closest('summary')) e.preventDefault();
  const { action, id, path, provider, name } = target.dataset;
  switch (action) {
    case 'approve':
    case 'deny': {
      const card = target.closest<HTMLElement>('.tool')!;
      const feedback = card.querySelector<HTMLInputElement>(':scope > .approval .feedback')?.value.trim() || undefined;
      const always = card.querySelector<HTMLInputElement>(':scope > .approval .always')?.checked || undefined;
      card.querySelectorAll<HTMLButtonElement>(':scope > .approval button').forEach((b) => (b.disabled = true));
      post({ type: 'approve', id: id!, approved: action === 'approve', feedback, always: action === 'approve' ? always : undefined });
      break;
    }
    case 'preview':
      post({ type: 'previewApproval', id: id! });
      break;
    case 'diff':
      post({ type: 'openDiff', path: path! });
      break;
    case 'accept':
      post({ type: 'acceptChange', path: path! });
      break;
    case 'revert':
      post({ type: 'revertChange', path: path! });
      break;
    case 'toggle-hunks':
      if (ui.hunks.has(path!)) ui.hunks.delete(path!);
      else {
        ui.hunks.set(path!, undefined);
        post({ type: 'getHunks', path: path! });
      }
      renderChanges();
      break;
    case 'keep-hunk':
      target.setAttribute('disabled', '');
      post({ type: 'keepHunk', path: path!, index: Number(target.dataset.index) });
      break;
    case 'revert-hunk':
      target.setAttribute('disabled', '');
      post({ type: 'revertHunk', path: path!, index: Number(target.dataset.index) });
      break;
    case 'accept-all':
      post({ type: 'acceptAll' });
      break;
    case 'revert-all':
      post({ type: 'revertAll' });
      break;
    case 'set-key':
      post({ type: 'setApiKey', provider: provider || undefined });
      break;
    case 'clear-key':
      post({ type: 'clearApiKey', provider: provider! });
      break;
    case 'check-claude-code':
      post({ type: 'checkClaudeCode' });
      break;
    case 'update-claude-code':
      target.setAttribute('disabled', '');
      post({ type: 'updateClaudeCode' });
      break;
    case 'handoff':
      post({ type: 'handoff', agent: target.dataset.agent ?? '', text: el.input.value });
      break;
    case 'open-folder':
      post({ type: 'openFolder', path: path || undefined });
      break;
    case 'dialog-action':
    case 'dialog-pick':
      answerDialog(target.dataset.dialog!, action === 'dialog-pick' ? Number(target.dataset.index) : target.dataset.value);
      break;
    case 'dialog-submit': {
      const input = document.querySelector<HTMLInputElement>(`.dialog[data-dialog="${CSS.escape(target.dataset.dialog!)}"] .dialog-input`);
      answerDialog(target.dataset.dialog!, input?.value ?? '');
      break;
    }
    case 'dialog-cancel':
      answerDialog(target.dataset.dialog!, undefined);
      break;
    case 'check-updates':
      target.setAttribute('disabled', '');
      post({ type: 'checkForUpdates' });
      break;
    case 'pick-claude-exe':
      post({ type: 'pickClaudeExecutable' });
      break;
    case 'reset-claude-exe':
      post({ type: 'resetClaudeExecutable' });
      break;
    case 'rewind':
      if (target.dataset.id) post({ type: 'rewind', id: target.dataset.id });
      break;
    case 'init-memory':
      post({ type: 'initMemory' });
      break;
    case 'vscode-settings':
      post({ type: 'openSettings' });
      break;
    case 'set-setting':
      post({ type: 'setSetting', key: target.dataset.key!, value: target.dataset.value });
      break;
    case 'step-setting': {
      const s = config?.settings.supervisor.maxInterventions ?? 5;
      const next = Math.min(50, Math.max(1, s + Number(target.dataset.delta)));
      post({ type: 'setSetting', key: 'supervisor.maxInterventions', value: next });
      break;
    }
    case 'toggle-plan':
      ui.planCollapsed = !ui.planCollapsed;
      renderPlan();
      break;
    case 'toggle-agents':
      ui.agentsOpen = !ui.agentsOpen;
      renderAgentsPanel();
      break;
    case 'toggle-usage':
      ui.usageOpen = !ui.usageOpen;
      renderUsage();
      if (layout === 'ide') renderTopbar();
      break;
    case 'composer-menu':
      renderComposerMenu(!!el.composerMenu?.hidden);
      break;
    case 'attach-file':
      renderComposerMenu(false);
      insertAtCursor('@');
      break;
    case 'attach-image':
      renderComposerMenu(false);
      el.imageInput?.click();
      break;
    case 'insert-command':
      renderComposerMenu(false);
      // A command or skill starts the message.
      if (!el.input.value.trim()) {
        el.input.value = '';
        insertAtCursor('/');
      } else el.input.focus();
      break;
    case 'open-settings':
      ui.view = 'settings';
      ui.agentsOpen = false;
      if (target.dataset.tab) ui.tab = target.dataset.tab as SettingsTab;
      if (ui.tab === 'skills') post({ type: 'reloadSkills' });
      renderView();
      break;
    case 'close-settings':
      ui.view = 'chat';
      renderView();
      break;
    case 'tab':
      ui.tab = target.dataset.tab as SettingsTab;
      if (ui.tab === 'skills') post({ type: 'reloadSkills' });
      renderSettings();
      break;
    case 'toggle-sidebar':
      toggleSidebar();
      break;
    case 'toggle-aside':
      toggleAside();
      break;
    case 'search-sessions':
      searchSessions();
      break;
    case 'to-bottom':
      el.transcript.scrollTo({ top: el.transcript.scrollHeight, behavior: 'smooth' });
      break;
    case 'copy-message': {
      const item = session.items.find((i) => i.id === id);
      if (item?.kind !== 'assistant') break;
      void navigator.clipboard.writeText(item.text);
      target.innerHTML = icon('check');
      target.setAttribute('aria-label', t('Copied'));
      setTimeout(() => {
        target.innerHTML = icon('copy');
        target.setAttribute('aria-label', t('Copy'));
      }, 1200);
      break;
    }
    case 'new-session':
      post({ type: 'newTask', folder: target.dataset.folder || undefined });
      ui.view = 'chat';
      renderView();
      break;
    case 'open-session':
      post({ type: 'openTask', id: id!, folder: target.dataset.folder || undefined });
      ui.view = 'chat';
      renderView();
      break;
    case 'delete-session':
      post({ type: 'deleteTask', id: id!, folder: target.dataset.folder || undefined });
      break;
    case 'check-app-update':
      target.setAttribute('disabled', '');
      post({ type: 'checkAppUpdate' });
      break;
    case 'open-release':
      post({ type: 'openRelease' });
      break;
    case 'new-task':
      post({ type: 'newTask' });
      if (ui.view === 'history') {
        ui.view = 'chat';
        renderView();
      }
      break;
    case 'compact':
      post({ type: 'compact' });
      break;
    case 'open-history':
      openHistory();
      break;
    case 'open-task':
      post({ type: 'openTask', id: id! });
      ui.view = 'chat';
      renderView();
      break;
    case 'delete-task':
      post({ type: 'deleteTask', id: id! });
      break;
    case 'remove-provider':
      post({ type: 'removeProvider', id: id! });
      break;
    case 'load-models':
      post({ type: 'loadModels', provider: provider! });
      break;
    case 'add-provider': {
      const select = document.getElementById('add-provider-preset') as HTMLSelectElement | null;
      if (select?.value) post({ type: 'addProvider', preset: select.value });
      break;
    }
    case 'open-skill':
      post({ type: 'openSkill', name: name! });
      break;
    case 'customize-skill':
      post({ type: 'customizeSkill', name: name! });
      break;
    case 'new-skill':
      post({ type: 'newSkill' });
      break;
    case 'open-skills-folder':
      post({ type: 'openSkillsFolder' });
      break;
    case 'import-mcp':
      post({ type: 'importMcp' });
      break;
    case 'restart-mcp':
      post({ type: 'restartMcp' });
      break;
    case 'edit-mcp':
      post({ type: 'editMcpServers' });
      break;
    case 'reload-skills':
      post({ type: 'reloadSkills' });
      break;
    case 'use-skill':
      ui.view = 'chat';
      renderView();
      el.input.value = `/${name} `;
      el.input.focus();
      autoGrow();
      break;
    case 'remove-attachment':
      composer.attachments = composer.attachments.filter((f) => f !== path);
      renderChips();
      break;
    case 'remove-image':
      composer.images.splice(Number(target.dataset.index), 1);
      renderChips();
      break;
    case 'pick-suggestion':
      pickSuggestion(Number(target.dataset.index));
      break;
    case 'example':
      el.input.value = target.dataset.text ?? '';
      el.input.focus();
      autoGrow();
      break;
    case 'copy': {
      const code = target.parentElement?.querySelector('code')?.textContent ?? '';
      void navigator.clipboard.writeText(code);
      target.textContent = t('Copied');
      setTimeout(() => (target.textContent = t('Copy')), 1200);
      break;
    }
  }
});

document.addEventListener('change', (e) => {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLSelectElement && target.id === 'mode') {
    post({ type: 'setMode', mode: target.value as ConfigView['mode'] });
    return;
  }
  if (target instanceof HTMLSelectElement && target.id === 'folder') {
    post({ type: 'selectFolder', path: target.value });
    return;
  }
  if (target instanceof HTMLInputElement && target.dataset.mcp) {
    post({ type: 'toggleMcpServer', name: target.dataset.mcp, enabled: target.checked });
    return;
  }
  if (target instanceof HTMLInputElement && target.dataset.skill) {
    post({ type: 'toggleSkill', name: target.dataset.skill, enabled: target.checked });
    return;
  }
  // Generic settings controls.
  const key = target.dataset.setting;
  if (key && (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
    let value: unknown = target.value;
    if (target instanceof HTMLInputElement && target.type === 'checkbox') value = target.checked;
    else if (target instanceof HTMLInputElement && target.type === 'radio') {
      if (!target.checked) return;
    } else if (target.dataset.type === 'int') {
      value = Number.parseInt(target.value, 10);
      if (!Number.isFinite(value as number)) return;
    }
    post({ type: 'setSetting', key, value });
    return;
  }
  // Provider / model pickers.
  if (!(target instanceof HTMLSelectElement) || !config) return;
  const agent = target.dataset.agent;
  if (!agent) return;
  if (agent.startsWith('provider:')) {
    // A provider's default model (Settings > Providers).
    if (target.value === '__other__') {
      post({ type: 'customModel', agent });
      renderSettings();
    } else {
      post({ type: 'setSetting', key: `model:${agent.slice('provider:'.length)}`, value: target.value });
    }
    return;
  }
  const view = agentView(agent);
  if (!view) return;
  if (target.dataset.action === 'agent-provider') {
    post({ type: 'setAgent', agent, provider: target.value, model: '' });
  } else if (target.dataset.action === 'agent-model') {
    if (target.value === '__other__') {
      post({ type: 'customModel', agent });
      target.value = view.effective.model;
    } else {
      post({ type: 'setAgent', agent, provider: view.provider === 'inherit' ? view.effective.provider : view.provider, model: target.value });
    }
  }
});

function agentView(name: string): AgentView | undefined {
  if (!config) return undefined;
  if (name === 'main') return config.main;
  if (name === 'supervisor') return config.supervisor;
  if (name === 'fallback') return config.fallback;
  if (name === 'light') return config.light;
  return config.subagents.find((a) => a.name === name);
}

// ------------------------------------------------------------------ chrome

function phaseLabel(phase: AgentPhase): string {
  const labels: Record<AgentPhase, string> = {
    idle: t('Ready'),
    thinking: t('Thinking'),
    analyzing: t('Analyzing'),
    planning: t('Planning'),
    implementing: t('Implementing'),
    verifying: t('Verifying'),
    delegating: t('Delegating'),
  };
  return labels[phase];
}

function modeLabel(mode: ConfigView['mode']): string {
  return { ask: t('Ask'), balanced: t('Balanced'), autonomous: t('Autonomous') }[mode];
}

function providerView(kind: string): ProviderView | undefined {
  return config?.providers.find((p) => p.kind === kind);
}

/** "Opus 5.5" for a model the provider knows, else the id. */
function modelLabel(provider: string, model: string): string {
  const label = providerView(provider)?.models.find((m) => m.id === model)?.label;
  return label ? t(label) : model;
}

function shortModel(provider: string, model: string): string {
  const label = providerView(provider)?.label.replace(/ \(local\)| API/, '') ?? provider;
  return model === 'default' ? label : `${label} · ${modelLabel(provider, model)}`;
}

let history: { tasks: TaskSummary[]; currentId?: string } = { tasks: [] };

function openHistory(): void {
  ui.view = 'history';
  ui.agentsOpen = false;
  post({ type: 'listTasks' });
  renderView();
}

function renderHistory(): void {
  el.history.hidden = ui.view !== 'history';
  if (el.history.hidden) return;
  el.history.innerHTML = history.tasks.length
    ? `<div class="settings-body">${history.tasks
        .map(
          (task) => `<div class="card history-row${task.id === history.currentId ? ' current' : ''}">
        <button class="history-open" data-action="open-task" data-id="${attr(task.id)}"><strong>${escapeHtml(task.title)}</strong>
          <span class="muted small">${ago(task.updatedAt)} · ${tn('{n} request', '{n} requests', task.requests)}${task.model ? ` · ${escapeHtml(task.model)}` : ''}${
            task.usage ? ` · ${t('{n} tok', { n: fmt(totalTokens(task.usage)) })}` : ''
          }</span></button>
        <button class="icon-btn" data-action="delete-task" data-id="${attr(task.id)}" aria-label="${attr(t('Delete task'))}" title="${attr(t('Delete'))}">${icon('delete')}</button></div>`,
        )
        .join('')}</div>`
    : `<div class="settings-body"><p class="footnote">${escapeHtml(t('No earlier tasks yet. Tasks are saved automatically when a request finishes.'))}</p></div>`;
}

function renderTopbar(): void {
  if (ui.view === 'history') {
    el.topbar.innerHTML = `<button class="icon-btn" data-action="close-settings" aria-label="${attr(t('Back to chat'))}" title="${attr(t('Back to chat'))}">${icon('back')}</button>
      <strong class="topbar-title">${escapeHtml(t('History'))}</strong><button class="btn small" data-action="new-task">${icon('plus')}${escapeHtml(t('New task'))}</button>`;
    return;
  }
  if (ui.view === 'settings') {
    el.topbar.innerHTML = `
      <button class="icon-btn" data-action="close-settings" aria-label="${attr(t('Back to chat'))}" title="${attr(t('Back to chat'))}">${icon('back')}</button>
      <strong class="topbar-title">${escapeHtml(t('Settings'))}</strong>
      ${config?.canOpenFolder ? '' : `<button class="link" data-action="vscode-settings">${escapeHtml(t('Open in VS Code settings'))}</button>`}`;
    return;
  }
  const running = session.running;
  const phase = running ? (session.phase === 'idle' ? 'thinking' : session.phase) : 'idle';
  const folderName = config?.folder?.split(/[\\/]/).filter(Boolean).pop();
  const folderButton =
    config?.canOpenFolder && folderName
      ? `<button class="folder-btn" data-action="open-folder" title="${attr(`${config.folder} - ${t('Open folder…')}`)}">${icon('folder')}<span>${escapeHtml(folderName)}</span></button>`
      : '';
  if (layout === 'ide') {
    el.topbar.innerHTML = ideTopbar(phase, folderButton);
    return;
  }
  const main = config?.main.effective;
  const warn = main && !providerView(main.provider)?.ready;
  el.topbar.innerHTML = `
    <div class="phase" data-phase="${attr(phase)}"><span class="dot"></span><span class="phase-label">${escapeHtml(phaseLabel(phase))}</span></div>
    ${folderButton}
    ${
      main
        ? `<button class="agent-btn${ui.agentsOpen ? ' open' : ''}${warn ? ' warn' : ''}" data-action="toggle-agents" title="${attr(t('Agents: providers and models'))}">${icon('agent')}<span>${escapeHtml(shortModel(main.provider, main.model))}</span>${icon('chevron', 'chev')}</button>`
        : ''
    }
    ${modeSelect()}
    <button class="icon-btn" data-action="new-task" aria-label="${attr(t('New task'))}" title="${attr(t('New task'))}">${icon('plus')}</button>
    <button class="icon-btn" data-action="open-history" aria-label="${attr(t('History'))}" title="${attr(t('Earlier tasks'))}">${icon('history')}</button>
    <button class="icon-btn" data-action="open-settings" aria-label="${attr(t('Settings'))}" title="${attr(t('Settings'))}">${icon('gear')}</button>`;
}

function modeSelect(): string {
  return `<select id="mode" title="${attr(t('Permission mode'))}" aria-label="${attr(t('Permission mode'))}">
      ${(['ask', 'balanced', 'autonomous'] as const)
        .map((m) => `<option value="${m}"${config?.mode === m ? ' selected' : ''}>${escapeHtml(modeLabel(m))}</option>`)
        .join('')}
    </select>`;
}

/**
 * IDE layout: a quiet title bar. The session's title (with what the agent is doing while it
 * works), the folder, the tokens used so far, and the switch for the plan-and-changes panel.
 * New task, history and settings live in the session list; model and mode in the message box.
 */
function ideTopbar(phase: AgentPhase, folderButton: string): string {
  const title = sessionTitle() || t('New session');
  const u = session.usage;
  const tokens = u ? totalTokens(u) : 0;
  const usage = tokens
    ? `<button class="usage-btn${ui.usageOpen ? ' open' : ''}" data-action="toggle-usage" title="${attr(t('Token usage per agent'))}">${escapeHtml(t('{n} tokens', { n: fmt(tokens) }))}</button>`
    : '';
  const asideLabel = ui.asideClosed ? t('Show plan and changes') : t('Hide plan and changes');
  const aside = asideContent()
    ? `<button class="icon-btn aside-btn${ui.asideClosed ? '' : ' on'}" data-action="toggle-aside" aria-label="${attr(asideLabel)}" title="${attr(`${asideLabel} (Ctrl+Alt+B)`)}">${icon('aside')}${
        session.changes.length ? `<span class="count">${Number(session.changes.length) || 0}</span>` : ''
      }</button>`
    : '';
  return `<div class="phase session-head" data-phase="${attr(phase)}"><span class="dot"></span><span class="session-title" title="${attr(title)}">${escapeHtml(title)}</span>${
    session.running ? `<span class="phase-label">${escapeHtml(phaseLabel(phase))}</span>` : ''
  }</div>${folderButton}${usage}${aside}`;
}

function renderMeta(): void {
  const label = session.running ? t('Stop') : t('Send');
  // IDE layout: a round button with just the icon.
  const glyph = session.running ? 'stop' : layout === 'ide' ? 'arrowUp' : 'send';
  el.send.innerHTML = `${icon(glyph)}<span>${escapeHtml(label)}</span>`;
  el.send.setAttribute('aria-label', label);
  el.send.title = layout === 'ide' ? `${label}${session.running ? '' : ' (Enter)'}` : '';
  el.send.classList.toggle('danger', session.running);
  el.send.disabled = !config?.workspaceOpen;
  const u = session.usage;
  const tokens = u
    ? ` · ${t('{n} in', { n: fmt(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens) })} · ${t('{n} out', { n: fmt(u.outputTokens) })}${
        u.cacheReadTokens ? ` · ${t('{n}% cached', { n: Math.round((100 * u.cacheReadTokens) / (u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)) })}` : ''
      }`
    : '';
  const main = config?.main.effective;
  const model = session.model || (main ? modelLabel(main.provider, main.model) : '');
  el.meta.textContent = `${model}${tokens}`;
}

function renderChrome(): void {
  renderTopbar();
  renderMeta();
  renderComposerTools();
}

// ------------------------------------------------------------------ usage

function agentLabel(agent: string): string {
  return agent === 'main' ? t('Main agent') : agent === 'supervisor' ? 'Supervisor' : agent;
}

function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

function costText(entry: AgentUsage): string {
  const cost = estimateCost(entry.provider, entry.model, entry.usage, config?.pricing);
  if (cost.kind === 'usd') return cost.usd < 0.01 ? '< $0.01' : `≈ $${cost.usd.toFixed(2)}`;
  if (cost.kind === 'subscription') return t('subscription');
  return '';
}

function usageSummary(u: Usage): string {
  const cached = u.cacheReadTokens ? ` · ${t('{n} cached', { n: fmt(u.cacheReadTokens) })}` : '';
  return `${t('{n} in', { n: fmt(u.inputTokens + u.cacheWriteTokens) })} · ${t('{n} out', { n: fmt(u.outputTokens) })}${cached}`;
}

/** "This task: …" line for an agent card. */
function agentUsageLine(agent: string): string {
  const entry = session.usageByAgent?.find((u) => u.agent === agent);
  if (!entry) return '';
  const cost = costText(entry);
  return `<div class="usage-line">${icon('dash', 'muted')}<span>${escapeHtml(t('This task:'))} ${tn('{n} call', '{n} calls', entry.calls)} · ${usageSummary(entry.usage)}${
    cost ? ` · ${escapeHtml(cost)}` : ''
  }</span></div>`;
}

function renderUsage(): void {
  el.meta.classList.toggle('open', ui.usageOpen);
  const entries = session.usageByAgent ?? [];
  el.usage.hidden = ui.view !== 'chat' || !ui.usageOpen;
  if (el.usage.hidden) return;
  const close = `<button class="icon-btn" data-action="toggle-usage" aria-label="${attr(t('Close'))}" title="${attr(t('Close'))}">${icon('x')}</button>`;
  if (!entries.length) {
    el.usage.innerHTML = `<div class="panel-head"><strong>${escapeHtml(t('Usage'))}</strong><span class="muted">${escapeHtml(t('no model calls in this task yet'))}</span><span class="spacer"></span>${close}</div>`;
    return;
  }
  const grand = entries.reduce((n, e) => n + totalTokens(e.usage), 0) || 1;
  let usd = 0;
  let priced = true;
  for (const e of entries) {
    const cost = estimateCost(e.provider, e.model, e.usage, config?.pricing);
    if (cost.kind === 'usd') usd += cost.usd;
    else if (cost.kind === 'unknown') priced = false;
  }
  const rows = entries
    .map((e) => {
      const share = Math.max(2, Math.round((100 * totalTokens(e.usage)) / grand));
      const role = e.agent === 'main' ? 'main' : e.agent === 'supervisor' ? 'supervisor' : 'sub';
      const provider = providerView(e.provider)?.label.replace(/ \(local\)/, '') ?? e.provider;
      return `<div class="usage-row ${role}">
        <div class="usage-row-head"><strong>${escapeHtml(agentLabel(e.agent))}</strong>
          <span class="muted ellipsis" title="${attr(`${provider} · ${e.model}`)}">${escapeHtml(provider)} · ${escapeHtml(e.model)}</span>
          <span class="spacer"></span><span class="usage-cost">${escapeHtml(costText(e))}</span></div>
        <div class="usage-bar" aria-hidden="true"><span data-width="${share}"></span></div>
        <div class="usage-nums muted">${tn('{n} call', '{n} calls', e.calls)} · ${usageSummary(e.usage)}</div>
      </div>`;
    })
    .join('');
  const total = session.usage ? usageSummary(session.usage) : '';
  el.usage.innerHTML = `
    <div class="panel-head"><strong>${escapeHtml(t('Usage'))}</strong><span class="muted">${escapeHtml(t('this task, per agent'))}</span><span class="spacer"></span>${close}</div>
    ${rows}
    <div class="usage-total"><span>${escapeHtml(t('Total'))}</span><span class="muted">${total}</span><span class="spacer"></span><strong>${usd > 0 ? `≈ $${usd.toFixed(2)}${priced ? '' : ' +'}` : ''}</strong></div>
    <p class="footnote">${escapeHtml(
      t('Costs are estimates from list prices for Claude API models and from your own price table (setting orka.pricing). Claude Code runs on your subscription.'),
    )}</p>`;
  applyWidths(el.usage);
}

// ------------------------------------------------------------------ agents (panel + settings tab)

function providerOptions(selected: string, allowInherit: boolean, inheritLabel = t('Same as main')): string {
  const options = (config?.providers ?? []).map(
    (p) => `<option value="${attr(p.kind)}"${p.kind === selected ? ' selected' : ''}>${escapeHtml(p.label)}${p.ready ? '' : ` – ${escapeHtml(t('no key'))}`}</option>`,
  );
  if (allowInherit) options.unshift(`<option value="inherit"${selected === 'inherit' ? ' selected' : ''}>${escapeHtml(inheritLabel)}</option>`);
  return options.join('');
}

/** Model picker grouped by family ("Claude Opus": Opus 5.5, Opus 5, ...), with the selected model always present. */
function modelOptions(provider: ProviderView | undefined, selected: string): string {
  const models = provider?.models ?? [];
  const groups = new Map<string, ModelInfo[]>();
  if (selected && !models.some((m) => m.id === selected)) groups.set(t('Current'), [{ id: selected, label: selected, family: t('Current') }]);
  for (const m of models) {
    const list = groups.get(m.family) ?? [];
    list.push(m);
    groups.set(m.family, list);
  }
  const option = (m: ModelInfo) =>
    `<option value="${attr(m.id)}"${m.id === selected ? ' selected' : ''} title="${attr(m.id)}">${escapeHtml(t(m.label))}${m.note ? ` · ${escapeHtml(t(m.note))}` : ''}</option>`;
  const body = [...groups].map(([family, list]) => `<optgroup label="${attr(t(family))}">${list.map(option).join('')}</optgroup>`).join('');
  return (
    (selected ? '' : `<option value="" disabled selected>${escapeHtml(t('Choose a model…'))}</option>`) +
    body +
    `<option value="__other__">${escapeHtml(t('Other…'))}</option>`
  );
}

function pickers(agent: AgentView, allowInherit: boolean, inheritLabel?: string): string {
  const inherit = agent.provider === 'inherit';
  const effective = providerView(agent.effective.provider);
  const warn = !effective?.ready && !inherit;
  return `<div class="pickers">
      <select class="${warn ? 'warn' : ''}" data-action="agent-provider" data-agent="${attr(agent.name)}" aria-label="${attr(t('Provider'))}">${providerOptions(allowInherit ? agent.provider : agent.effective.provider, allowInherit, inheritLabel)}</select>
      <select data-action="agent-model" data-agent="${attr(agent.name)}" aria-label="${attr(t('Model'))}"${inherit ? ' disabled' : ''}>${modelOptions(effective, agent.effective.model)}</select>
    </div>
    ${
      warn
        ? `<div class="hint warn">${icon('key')}<span>${escapeHtml(t('{provider} needs an API key.', { provider: effective?.label ?? '' }))}</span><button class="link" data-action="set-key" data-provider="${attr(agent.effective.provider)}">${escapeHtml(t('Add key'))}</button></div>`
        : ''
    }`;
}

function mainCard(): string {
  if (!config) return '';
  const main = config.main;
  const p = providerView(main.effective.provider);
  const status =
    p?.kind === 'claude-code'
      ? claudeCodeLine(config.settings.claudeCode.status)
      : p?.ready
        ? `<div class="hint ok">${icon('check')}<span>${escapeHtml(p.key?.source === 'env' ? t('Key from {name}', { name: p.key.hint }) : t('API key stored'))}</span></div>`
        : '';
  return `<div class="card">
    <div class="card-head"><strong>${escapeHtml(t('Main agent'))}</strong><span class="muted">${escapeHtml(t('plans, edits, runs'))}</span></div>
    ${pickers(main, false)}
    <div class="field fallback-field"><span class="field-label">${escapeHtml(t('Answer simple questions with'))}</span>${pickers(config.light, true, t('Off'))}</div>
    <div class="field fallback-field"><span class="field-label">${escapeHtml(t('If its limit is reached, continue with'))}</span>${pickers(config.fallback, true, t('Off'))}</div>
    ${status}
    ${agentUsageLine('main')}
  </div>`;
}

function claudeCodeLine(status: SettingsView['claudeCode']['status']): string {
  switch (status.state) {
    case 'ready':
      return `<div class="hint ok">${icon('check')}<span>${escapeHtml(t('Logged in'))}${status.account ? ` · ${escapeHtml(status.account)}` : ''} · ${escapeHtml(t('no API key needed'))}</span></div>`;
    case 'checking':
      return `<div class="hint"><span class="spinner small"></span><span>${escapeHtml(t('Checking Claude Code…'))}</span></div>`;
    case 'logged_out':
      return `<div class="hint warn">${icon('warn')}<span>${escapeHtml(t('Claude Code is not logged in.'))} ${escapeHtml(status.detail ?? '')}</span></div>`;
    case 'not_found':
      return `<div class="hint warn">${icon('warn')}<span>${escapeHtml(t('Claude Code CLI not found.'))}</span><button class="link" data-action="open-settings" data-tab="providers">${escapeHtml(t('Set up'))}</button></div>`;
    case 'error':
      return `<div class="hint warn">${icon('warn')}<span>${escapeHtml(t('Claude Code check failed.'))}</span><button class="link" data-action="check-claude-code">${escapeHtml(t('Retry'))}</button></div>`;
    default:
      return '';
  }
}

function segmented(key: string, value: string, options: Array<[string, string]>, label: string): string {
  return `<div class="segmented" role="group" aria-label="${attr(label)}">${options
    .map(([v, l]) => `<button class="${value === v ? 'on' : ''}" data-action="set-setting" data-key="${attr(key)}" data-value="${attr(v)}" aria-pressed="${value === v}">${escapeHtml(l)}</button>`)
    .join('')}</div>`;
}

function supervisorCard(): string {
  if (!config) return '';
  const s = config.settings.supervisor;
  return `<div class="card supervisor-card${s.enabled ? '' : ' off'}">
    <div class="card-head">${icon('eye', 'sup')}<strong>Supervisor</strong><span class="spacer"></span>
      <label class="switch"><input type="checkbox" data-setting="supervisor.enabled"${s.enabled ? ' checked' : ''}> ${escapeHtml(s.enabled ? t('On') : t('Off'))}</label></div>
    <div class="card-text">${escapeHtml(
      t('Compares the work with what you asked and warns the main agent about logical problems. It never does the work itself; its guidance appears in the chat.'),
    )}</div>
    ${
      s.enabled
        ? `${pickers(config.supervisor, true)}
    <div class="field"><span class="field-label">${escapeHtml(t('Reviews'))}</span>
      ${segmented(
        'supervisor.frequency',
        s.frequency,
        [
          ['checkpoints', t('Smart')],
          ['on_changes', t('On changes')],
          ['every_turn', t('Every step')],
          ['final_only', t('Final only')],
        ],
        t('Review frequency'),
      )}
      <span class="muted small">${escapeHtml(
        s.frequency === 'checkpoints'
          ? t('Checks the plan, steps in when the agent is stuck or asks for help, and reviews the result - from a short summary. Fewest tokens.')
          : s.frequency === 'final_only'
            ? t('Only the final result is reviewed.')
            : t('Steps are reviewed one by one: thorough, but uses many more tokens.'),
      )}</span>
    </div>
    ${
      s.frequency === 'on_changes' || s.frequency === 'every_turn'
        ? `<div class="field"><span class="field-label">${escapeHtml(t('Timing'))}</span>
      ${segmented('supervisor.mode', s.mode, [['parallel', t('Parallel')], ['blocking', t('Wait for review')]], t('Review timing'))}
      <span class="muted small">${escapeHtml(
        s.mode === 'blocking'
          ? t('The agent waits for each review; corrections land one step earlier, but every step is slower.')
          : t('The agent keeps working while a step is reviewed; a correction arrives with its next step.'),
      )}</span>
    </div>`
        : ''
    }
    <div class="row"><span class="grow">${escapeHtml(t('Max corrections per request'))}</span>
      <div class="stepper"><button data-action="step-setting" data-delta="-1" aria-label="${attr(t('Fewer'))}">−</button><span>${escapeHtml(String(s.maxInterventions))}</span><button data-action="step-setting" data-delta="1" aria-label="${attr(t('More'))}">+</button></div>
    </div>
    ${agentUsageLine('supervisor')}`
        : ''
    }
  </div>`;
}

function subagentsCard(): string {
  if (!config) return '';
  const rows = config.subagents
    .map(
      (a) => `<div class="sub-row">
      <div class="sub-row-head"><strong class="sub-name">${escapeHtml(a.name)}</strong><span class="tag">${escapeHtml(a.access === 'readonly' ? t('read-only') : t('edits'))}</span>
        <span class="muted ellipsis" title="${attr(a.description ?? '')}">${escapeHtml(shortDescription(a.description))}</span></div>
      ${pickers(a, true)}
      ${agentUsageLine(a.name)}
    </div>`,
    )
    .join('');
  return `<div class="card">
    <div class="card-head">${icon('agent', 'sub')}<strong>Sub-agents</strong><span class="muted grow">${escapeHtml(t('the main agent delegates to them'))}</span>
      <label class="switch"><input type="checkbox" data-setting="subagents.enabled"${config.subagentsEnabled ? ' checked' : ''}> ${escapeHtml(config.subagentsEnabled ? t('On') : t('Off'))}</label></div>
    ${config.subagentsEnabled ? rows : ''}
    ${
      config.subagentsEnabled
        ? `<div class="row"><span class="grow">${escapeHtml(t('Sub-agents at the same time'))}<br><span class="muted small">${escapeHtml(
            t('explore, review and workers called together run side by side, up to this many'),
          )}</span></span>
      <input class="num" type="number" min="1" max="8" data-type="int" data-setting="subagents.maxParallel" value="${attr(String(config.settings.subagentsMaxParallel))}" aria-label="${attr(t('Parallel sub-agents'))}"></div>
      <label class="check"><input type="checkbox" data-setting="subagents.parallelWorkers"${config.settings.parallelWorkers ? ' checked' : ''}><span>${escapeHtml(
        t('Workers side by side in copies of the project'),
      )}<br><span class="muted">${escapeHtml(t('Each worker edits its own copy; the changes are merged afterwards and overlaps are reported. Off: workers run one at a time in the project.'))}</span></span></label>`
        : ''
    }
  </div>`;
}

function shortDescription(text?: string): string {
  if (!text) return '';
  const first = text.split('. ')[0].replace(/\.$/, '');
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

function agentsHtml(): string {
  return `${mainCard()}${supervisorCard()}${subagentsCard()}${externalAgentsCard()}`;
}

/** Agents with no API (Freebuff): Orka hands the task over and reviews what they changed. */
function externalAgentsCard(): string {
  const agents = config?.externalAgents ?? [];
  if (!agents.length) return '';
  const rows = agents
    .map(
      (a) => `<div class="row handoff-row">
      <span class="grow"><strong>${escapeHtml(a.label)}</strong> <span class="tag">${escapeHtml(a.installed ? t('installed') : t('not installed'))}</span><br>
        <span class="muted small">${escapeHtml(a.description)}</span></span>
      <button class="btn small" data-action="handoff" data-agent="${attr(a.id)}" title="${attr(t('Opens it in a terminal with the task summary on the clipboard; Orka then shows what it changed'))}">${icon('handoff')}${escapeHtml(
        a.active ? t('Show terminal') : a.installed ? t('Continue in {agent}', { agent: a.label }) : t('Install {agent}', { agent: a.label }),
      )}</button>
    </div>`,
    )
    .join('');
  return `<div class="card">
    <div class="card-head">${icon('handoff')}<strong>${escapeHtml(t('Other agents'))}</strong><span class="muted grow">${escapeHtml(t('hand the task over; Orka reviews what they change'))}</span></div>
    ${rows}
  </div>`;
}

function renderAgentsPanel(): void {
  renderTopbar();
  renderComposerTools();
  el.agents.hidden = ui.view !== 'chat' || !ui.agentsOpen || !config;
  if (el.agents.hidden) return;
  el.agents.innerHTML = `
    <div class="panel-head"><strong>Agents</strong><span class="muted">${escapeHtml(t('who does what, on which model'))}</span><span class="spacer"></span>
      <button class="icon-btn" data-action="toggle-agents" aria-label="${attr(t('Close'))}" title="${attr(t('Close'))}">${icon('x')}</button></div>
    ${agentsHtml()}
    <button class="link" data-action="open-settings" data-tab="agents">${escapeHtml(t('All settings…'))}</button>`;
}

// ------------------------------------------------------------------ settings view

function select(setting: string, options: Array<[string, string]>, value: string, label: string): string {
  return `<select data-setting="${attr(setting)}" aria-label="${attr(label)}">${options
    .map(([v, l]) => `<option value="${attr(v)}"${v === value ? ' selected' : ''}>${escapeHtml(l)}</option>`)
    .join('')}</select>`;
}

function providerModelSelect(p: ProviderView): string {
  return `<select data-agent="provider:${attr(p.kind)}" aria-label="${attr(t('{provider} default model', { provider: p.label }))}">${modelOptions(p, p.model)}</select>`;
}

/** "Default model" field with a button that loads the provider's own model list. */
function modelField(p: ProviderView): string {
  const canLoad = p.kind !== 'claude-code' && p.ready;
  return `<label class="field"><span class="field-label field-label-row">${escapeHtml(t('Default model'))}${
    canLoad
      ? `<button class="link" data-action="load-models" data-provider="${attr(p.kind)}" title="${attr(t('Load the model list from {provider}', { provider: p.label }))}">${escapeHtml(t('Load list'))}</button>`
      : ''
  }</span>${providerModelSelect(p)}</label>`;
}

function customProvidersSection(s: SettingsView): string {
  const customs = config!.providers.filter((p) => p.custom);
  const cards = customs
    .map((p) => {
      const c = p.custom!;
      const state = !c.requiresKey
        ? statusPill(true, t('No key needed'))
        : p.key
          ? statusPill(true, p.key.source === 'stored' ? t('Key stored') : t('From {name}', { name: p.key.hint }))
          : statusPill(false, t('No key'));
      return `<div class="card">
        <div class="card-head"><strong>${escapeHtml(p.label)}</strong>${c.requiresKey ? '' : `<span class="tag">${escapeHtml(t('local'))}</span>`}<span class="spacer"></span>${state}</div>
        <div class="key mono ellipsis" title="${attr(c.baseUrl)}">${escapeHtml(c.baseUrl)}</div>
        ${c.requiresKey ? keyRow(p) : ''}
        ${modelField(p)}${!p.models.length ? `<div class="hint">${escapeHtml(t('Load the list, or pick Other… to type a model id.'))}</div>` : ''}
        <button class="btn danger-outline" data-action="remove-provider" data-id="${attr(c.id)}">${escapeHtml(t('Remove provider'))}</button>
      </div>`;
    })
    .join('');
  const taken = new Set(customs.map((p) => p.custom!.id.replace(/-\d+$/, '')));
  const firstFree = s.presets.find((pr) => !taken.has(pr.id))?.id ?? 'custom';
  const options = s.presets
    .map((pr) => `<option value="${attr(pr.id)}"${pr.id === firstFree ? ' selected' : ''}>${escapeHtml(pr.label)}${taken.has(pr.id) ? ` ${escapeHtml(t('(added)'))}` : ''}</option>`)
    .join('');
  return `<div class="section"><strong class="section-title">${escapeHtml(t('Other providers'))}</strong>
      <span class="muted small">${escapeHtml(t('Any OpenAI-compatible service or local server. Every agent can use them.'))}</span></div>
    ${cards}
    <div class="card"><div class="card-head"><strong>${escapeHtml(t('Add a provider'))}</strong></div>
      <div class="key-row"><select id="add-provider-preset" aria-label="${attr(t('Provider to add'))}">${options}<option value="custom">${escapeHtml(t('Other (custom URL)…'))}</option></select>
      <button class="btn primary" data-action="add-provider">${escapeHtml(t('Add'))}</button></div></div>`;
}

function keyRow(p: ProviderView): string {
  if (p.key?.source === 'stored') {
    return `<div class="key-row"><span class="key mono">${escapeHtml(p.key.hint)}</span>
      <button class="btn" data-action="set-key" data-provider="${attr(p.kind)}">${escapeHtml(t('Change'))}</button>
      <button class="btn danger-outline" data-action="clear-key" data-provider="${attr(p.kind)}">${escapeHtml(t('Remove'))}</button></div>`;
  }
  if (p.key?.source === 'env') {
    return `<div class="key-row"><span class="key">${escapeHtml(t('Using {name}', { name: p.key.hint }))}</span><button class="btn" data-action="set-key" data-provider="${attr(p.kind)}">${escapeHtml(t('Store a key'))}</button></div>`;
  }
  return `<button class="btn primary" data-action="set-key" data-provider="${attr(p.kind)}">${escapeHtml(t('Add API key'))}</button>`;
}

function statusPill(ok: boolean, text: string): string {
  return `<span class="pill ${ok ? 'ok' : 'warn'}"><span class="pill-dot"></span>${escapeHtml(text)}</span>`;
}

/** Claude Code runs on the user's own login, so it stays off until they turn it on here. */
function claudeCodeCard(s: SettingsView, cc: ProviderView | undefined): string {
  const notice = `<div class="muted small">${escapeHtml(
    t('Unofficial: Orka is not affiliated with Anthropic. It runs your own Claude Code login, so make sure your use follows Anthropic\'s terms. For teams and products, use a Claude API key.'),
  )}</div>`;
  const toggle = `<label class="check"><input type="checkbox" data-setting="claudeCode.enabled"${s.claudeCode.enabled ? ' checked' : ''}><span>${escapeHtml(
    t('Use my local Claude Code CLI as a provider'),
  )}</span></label>`;
  if (!s.claudeCode.enabled || !cc) {
    return `
    <div class="card">
      <div class="card-head"><strong>Claude Code</strong><span class="tag">${escapeHtml(t('local CLI'))}</span><span class="spacer"></span><span class="pill">${escapeHtml(t('Off'))}</span></div>
      <div class="card-text">${escapeHtml(t('Runs the locally installed claude CLI with its own login, so no API key is needed.'))}</div>
      ${toggle}
      ${notice}
    </div>`;
  }
  const st = s.claudeCode.status;
  const ccState =
    st.state === 'ready'
      ? statusPill(true, t('Ready'))
      : st.state === 'checking'
        ? `<span class="pill"><span class="spinner small"></span>${escapeHtml(t('Checking'))}</span>`
        : statusPill(false, st.state === 'not_found' ? t('Not found') : st.state === 'logged_out' ? t('Logged out') : st.state === 'error' ? t('Error') : t('Unknown'));
  return `
    <div class="card">
      <div class="card-head"><strong>Claude Code</strong><span class="tag">${escapeHtml(t('local CLI'))}</span><span class="spacer"></span>${ccState}</div>
      ${toggle}
      <div class="card-text">${
        st.state === 'ready'
          ? `v${escapeHtml(st.version ?? '?')}${st.account ? ` · ${escapeHtml(st.account)}` : ''}. ${escapeHtml(t('Uses your Claude Code login; no API key.'))}`
          : escapeHtml(st.detail ?? t('Uses the locally installed claude CLI and its login.'))
      }</div>
      <div class="field"><span class="field-label">${escapeHtml(t('Executable'))}</span>
        <div class="key-row"><span class="key mono ellipsis" title="${attr(s.claudeCode.path || st.executable || '')}">${escapeHtml(
          s.claudeCode.path || (st.executable ? t('Auto: {path}', { path: st.executable }) : t('Auto-detect')),
        )}</span>
        <button class="btn" data-action="pick-claude-exe">${escapeHtml(t('Browse…'))}</button>${
          s.claudeCode.path ? `<button class="btn" data-action="reset-claude-exe">${escapeHtml(t('Auto'))}</button>` : ''
        }</div>
      </div>
      <div class="grid2">
        <label class="field"><span class="field-label">${escapeHtml(t('Default model'))}</span>${providerModelSelect(cc)}</label>
        <label class="field"><span class="field-label">Effort</span>${select('claudeCode.effort', claudeEfforts(), s.claudeCode.effort, 'Claude Code effort')}</label>
      </div>
      <label class="check"><input type="checkbox" data-setting="claudeCode.autoUpdate"${s.claudeCode.autoUpdate ? ' checked' : ''}><span>${escapeHtml(
        t('Update Claude Code automatically'),
      )}<br><span class="muted">${escapeHtml(t('Runs "claude update" once a day, and right away when a model needs a newer version.'))}</span></span></label>
      <div class="key-row">
        <button class="btn" data-action="check-claude-code">${escapeHtml(t('Test connection'))}</button>
        <button class="btn" data-action="update-claude-code"${s.claudeCode.updating || st.state === 'not_found' ? ' disabled' : ''}>${escapeHtml(s.claudeCode.updating ? t('Updating…') : t('Update'))}</button>
      </div>
      ${notice}
    </div>`;
}

const claudeEfforts = (): Array<[string, string]> => [['', t('CLI default')], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']];

function providersTab(s: SettingsView): string {
  const byKind = (k: string) => config!.providers.find((p) => p.kind === k)!;
  const levels: Array<[string, string]> = [['', t('model default')], ['low', 'low'], ['medium', 'medium'], ['high', 'high']];
  const claude = byKind('claude');
  const gemini = byKind('gemini');
  const openai = byKind('openai');
  const keyPill = (p: ProviderView) =>
    statusPill(!!p.key, p.key?.source === 'stored' ? t('Key stored') : p.key?.source === 'env' ? t('From {name}', { name: p.key.hint }) : t('No key'));
  const when = (at?: number) => (at ? ago(new Date(at).toISOString()) : t('not yet'));
  return `
    <div class="card">
      <div class="card-head"><strong>${escapeHtml(t('Updates'))}</strong><span class="spacer"></span>
        <button class="btn small" data-action="check-updates"${s.claudeCode.updating ? ' disabled' : ''}>${icon('refresh')}${escapeHtml(t('Check now'))}</button></div>
      <div class="card-text">${escapeHtml(t('Model lists are refreshed from every provider once a day, so new versions appear by themselves (marked "new").'))}</div>
      <div class="muted small">${escapeHtml(
        s.claudeCode.enabled
          ? t('Model lists: {when} · Claude Code: {cc}', { when: when(s.modelsRefreshedAt), cc: s.claudeCode.updating ? t('updating…') : when(s.claudeCode.updatedAt) })
          : t('Model lists: {when}', { when: when(s.modelsRefreshedAt) }),
      )}</div>
    </div>
    <div class="card">
      <div class="card-head"><strong>Claude API</strong><span class="spacer"></span>${keyPill(claude)}</div>
      ${keyRow(claude)}
      <div class="grid2">
        ${modelField(claude)}
        <label class="field"><span class="field-label">Effort</span>${select('claude.effort', claudeEfforts().slice(1), s.claude.effort, 'Claude effort')}</label>
      </div>
      <label class="check"><input type="checkbox" data-setting="claude.refusalFallback"${s.claude.refusalFallback ? ' checked' : ''}><span>${escapeHtml(
        t('Retry declined requests on a fallback model'),
      )}<br><span class="muted">${escapeHtml(t('Server-side fallback (beta)'))}</span></span></label>
    </div>
    ${claudeCodeCard(s, config!.providers.find((p) => p.kind === 'claude-code'))}
    <div class="card">
      <div class="card-head"><strong>Gemini API</strong><span class="spacer"></span>${keyPill(gemini)}</div>
      ${keyRow(gemini)}
      <div class="grid2">
        ${modelField(gemini)}
        <label class="field"><span class="field-label">${escapeHtml(t('Thinking'))}</span>${select('gemini.thinkingLevel', levels, s.gemini.thinkingLevel, t('Thinking'))}</label>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><strong>OpenAI API</strong><span class="spacer"></span>${keyPill(openai)}</div>
      ${keyRow(openai)}
      <label class="field"><span class="field-label">${escapeHtml(t('Base URL (OpenAI-compatible)'))}</span><input class="mono" type="text" data-setting="openai.baseUrl" value="${attr(s.openai.baseUrl)}" spellcheck="false"></label>
      <div class="grid2">
        ${modelField(openai)}
        <label class="field"><span class="field-label">Reasoning</span>${select('openai.reasoningEffort', levels, s.openai.reasoningEffort, 'OpenAI reasoning effort')}</label>
      </div>
    </div>
    ${customProvidersSection(s)}
    <p class="footnote">${escapeHtml(t("Keys are kept in VS Code's secret storage on this machine and are only sent to their provider."))}</p>`;
}

function skillsTab(): string {
  if (!config) return '';
  const on = config.skillsEnabled;
  const tag = (s: SkillView) =>
    s.source === 'builtin' ? `<span class="tag">${escapeHtml(t('built-in'))}</span>` : `<span class="tag sub">${escapeHtml(s.overridesBuiltin ? t('yours · replaces built-in') : t('yours'))}</span>`;
  const rows = config.skills
    .map(
      (s) => `<div class="skill-row${s.enabled && on ? '' : ' off'}">
      <div class="skill-head">
        <label class="switch" title="${attr(s.enabled ? t('Offered to the agents') : t('Not offered to the agents'))}"><input type="checkbox" data-skill="${attr(s.name)}"${s.enabled ? ' checked' : ''}${on ? '' : ' disabled'}></label>
        <strong class="mono">${escapeHtml(s.name)}</strong>${tag(s)}<span class="spacer"></span>
        <button class="link" data-action="use-skill" data-name="${attr(s.name)}" title="${attr(t('Use it for your next request'))}">/${escapeHtml(s.name)}</button>
        <button class="link" data-action="open-skill" data-name="${attr(s.name)}">${escapeHtml(t('Open'))}</button>
        ${s.source === 'builtin' ? `<button class="link" data-action="customize-skill" data-name="${attr(s.name)}" title="${attr(t('Copy it to your skills folder and edit the copy'))}">${escapeHtml(t('Customize'))}</button>` : ''}
      </div>
      <div class="muted small">${escapeHtml(s.description)}</div>
    </div>`,
    )
    .join('');
  const errors = config.skillErrors.length
    ? `<div class="card"><div class="card-head">${icon('warn', 'warn')}<strong>${escapeHtml(t('Skills that could not be loaded'))}</strong></div>${config.skillErrors
        .map((e) => `<div class="mono small ellipsis" title="${attr(e)}">${escapeHtml(e)}</div>`)
        .join('')}</div>`
    : '';
  return `
    <div class="card">
      <div class="card-head">${icon('skill', 'sub')}<strong>Skills</strong><span class="spacer"></span>
        <label class="switch"><input type="checkbox" data-setting="skills.enabled"${on ? ' checked' : ''}> ${escapeHtml(on ? t('On') : t('Off'))}</label></div>
      <div class="card-text">${escapeHtml(
        t('Skills are expert playbooks (Unity, debugging, testing, security…). Agents load the ones a task needs; type /name to use one yourself. They are global: the same skills in every project.'),
      )}</div>
      <div class="key-row">
        <button class="btn primary" data-action="new-skill">${icon('plus')}${escapeHtml(t('New skill'))}</button>
        <button class="btn" data-action="open-skills-folder">${icon('folder')}${escapeHtml(t('Open folder'))}</button>
        <button class="icon-btn" data-action="reload-skills" aria-label="${attr(t('Reload'))}" title="${attr(t('Reload'))}">${icon('refresh')}</button>
      </div>
    </div>
    ${errors}
    <div class="card skills-list">${rows || `<p class="footnote">${escapeHtml(t('No skills found.'))}</p>`}</div>
    <p class="footnote">${escapeHtml(t('Your skills folder: {path}. A skill is a Markdown file with a name and a description at the top; a file with the name of a built-in skill replaces it.', { path: config.skillsFolder }))}</p>`;
}

function mcpTab(): string {
  if (!config) return '';
  const m = config.mcp;
  const state = (s: McpServerView) =>
    !s.enabled
      ? statusPill(false, t('Off'))
      : s.state === 'ready'
        ? statusPill(true, tn('{n} tool', '{n} tools', s.tools))
        : s.state === 'starting'
          ? `<span class="pill"><span class="spinner small"></span>${escapeHtml(t('Starting'))}</span>`
          : s.state === 'error'
            ? statusPill(false, t('Error'))
            : `<span class="pill">${escapeHtml(t('Starts with the next task'))}</span>`;
  const rows = m.servers
    .map(
      (s) => `<div class="skill-row${s.enabled && m.enabled ? '' : ' off'}">
      <div class="skill-head">
        <label class="switch"><input type="checkbox" data-mcp="${attr(s.name)}"${s.enabled ? ' checked' : ''}${m.enabled ? '' : ' disabled'}></label>
        <strong class="mono">${escapeHtml(s.name)}</strong><span class="tag">${escapeHtml(s.transport)}</span>${s.source === 'workspace' ? '<span class="tag sub">.mcp.json</span>' : ''}
        <span class="spacer"></span>${state(s)}
      </div>
      <div class="mono muted small ellipsis" title="${attr(s.target)}">${escapeHtml(s.target)}</div>
      ${s.error && s.enabled ? `<div class="hint warn">${icon('warn')}<span>${escapeHtml(s.error)}</span></div>` : ''}
    </div>`,
    )
    .join('');
  return `
    <div class="card">
      <div class="card-head">${icon('plug', 'sub')}<strong>MCP</strong><span class="spacer"></span>
        <label class="switch"><input type="checkbox" data-setting="mcp.enabled"${m.enabled ? ' checked' : ''}> ${escapeHtml(m.enabled ? t('On') : t('Off'))}</label></div>
      <div class="card-text">${escapeHtml(
        t('MCP servers give the agents tools that work outside the project: the Unity Editor, Blender, a browser, a database… They start when a task needs them. Tools a server marks as destructive always ask first.'),
      )}</div>
      <div class="key-row">
        <button class="btn primary" data-action="import-mcp">${escapeHtml(t('Import from Claude Code'))}</button>
        <button class="btn" data-action="edit-mcp">${escapeHtml(t('Edit list'))}</button>
        <button class="icon-btn" data-action="restart-mcp" aria-label="${attr(t('Restart servers'))}" title="${attr(t('Restart servers'))}">${icon('refresh')}</button>
      </div>
    </div>
    <div class="card skills-list">${rows || `<p class="footnote">${escapeHtml(t('No MCP servers yet. Import yours from Claude Code, or add them to the list (settings.json).'))}</p>`}</div>
    <p class="footnote">${escapeHtml(t('A server is a command (stdio) or a URL (HTTP). A .mcp.json in the project folder is used after you allow it once.'))}</p>`;
}

function controlTab(s: SettingsView): string {
  const modes: Array<[string, string, string]> = [
    ['ask', t('Ask'), t('Approve every file change, command and plan.')],
    ['balanced', t('Balanced'), t('Edits files on its own; asks before deletes, git writes and risky commands.')],
    ['autonomous', t('Autonomous'), t('Works independently; only destructive actions still ask.')],
  ];
  const rule = (label: string, key: string, value: string, options: Array<[string, string]>) =>
    `<div class="row"><span class="grow">${escapeHtml(label)}</span>${select(key, options, value, label)}</div>`;
  const simple: Array<[string, string]> = [['mode', t('Follow mode')], ['auto', t('Allow')], ['ask', t('Always ask')]];
  const shellLabel = (v: string) => (v === '' ? t('Default') : v.replace(/^.*[\\/]/, ''));
  const folders = config?.folders;
  return `
    <div class="section">
      <strong class="section-title">${escapeHtml(t('Permission mode'))}</strong>
      ${modes
        .map(
          ([value, label, text]) => `<label class="radio-card${s.permissionMode === value ? ' on' : ''}">
        <input type="radio" name="permission-mode" data-setting="permissionMode" value="${attr(value)}"${s.permissionMode === value ? ' checked' : ''}>
        <span><span class="radio-title">${escapeHtml(label)}</span><span class="radio-text">${escapeHtml(text)}</span></span></label>`,
        )
        .join('')}
    </div>
    <div class="card">
      <div class="card-head"><strong>${escapeHtml(t('Per-category rules'))}</strong><span class="muted">${escapeHtml(t('override the mode'))}</span></div>
      ${rule(t('File edits'), 'permissions.fileEdit', s.permissions.fileEdit, simple)}
      ${rule(t('Terminal'), 'permissions.terminal', s.permissions.terminal, [['mode', t('Follow mode')], ['auto', t('Allow')], ['askDangerous', t('Ask if risky')], ['ask', t('Always ask')]])}
      ${rule(t('Git commit / push'), 'permissions.git', s.permissions.git, simple)}
      ${rule(t('Delete files'), 'permissions.delete', s.permissions.delete, simple)}
      ${rule(t('Web access'), 'permissions.network', s.permissions.network, simple)}
    </div>
    <div class="card">
      <div class="card-head"><strong>${escapeHtml(t('Behavior'))}</strong></div>
      <label class="check"><input type="checkbox" data-setting="autoVerify"${s.autoVerify ? ' checked' : ''}><span>${escapeHtml(t('Verify before finishing'))}<br><span class="muted">${escapeHtml(
        t('If code changed and nothing was built or tested, ask the agent to do it.'),
      )}</span></span></label>
      ${
        s.inlineReview === undefined
          ? ''
          : `<label class="check"><input type="checkbox" data-setting="inlineReview"${s.inlineReview ? ' checked' : ''}><span>${escapeHtml(t('Show changes in the editor'))}<br><span class="muted">${escapeHtml(
              t('Lines the agent added are highlighted, with Keep / Revert above each change.'),
            )}</span></span></label>`
      }
      <label class="check"><input type="checkbox" data-setting="trackCommandChanges"${s.trackCommandChanges.enabled ? ' checked' : ''}><span>${escapeHtml(
        t('Make command changes revertible'),
      )}<br><span class="muted">${escapeHtml(
        s.trackCommandChanges.unavailable
          ? t('Not available here: {reason}.', { reason: s.trackCommandChanges.unavailable })
          : t('Files changed by terminal commands (npm install, generators, formatters) join the Changes list and can be reverted. Uses a private snapshot, never your own git repository.'),
      )}</span></span></label>
      <div class="row"><span class="grow">${escapeHtml(t('Max steps per request'))}</span><input class="num" type="number" min="1" max="500" data-type="int" data-setting="maxIterations" value="${attr(String(s.maxIterations))}"></div>
      <div class="row"><span class="grow">${escapeHtml(t('Token budget per request'))}<br><span class="muted small">${escapeHtml(
        t('Pauses the request when all agents together used this many new tokens (cache reads not counted). 0 = no limit.'),
      )}</span></span><input class="num wide" type="number" min="0" step="50000" data-type="int" data-setting="tokenBudget" value="${attr(String(s.tokenBudget))}"></div>
      <div class="row"><span class="grow">${escapeHtml(t('Command timeout'))}</span><input class="num" type="number" min="5" max="3600" data-type="int" data-setting="commandTimeoutSeconds" value="${attr(String(s.commandTimeoutSeconds))}"><span class="muted">s</span></div>
      <div class="row"><span class="grow">Shell</span>${select('shell', s.shellChoices.map((v) => [v, shellLabel(v)] as [string, string]), s.shell, 'Shell')}</div>
      <label class="field"><span class="field-label">${escapeHtml(t('Custom instructions'))}</span>
        <textarea data-setting="customInstructions" rows="4" placeholder="${attr(t('e.g. Use UniTask instead of coroutines. Comments in Turkish.'))}">${escapeHtml(s.customInstructions)}</textarea></label>
    </div>
    <div class="card">
      <div class="card-head"><strong>${escapeHtml(t('Context'))}</strong><span class="muted">${escapeHtml(t('long tasks'))}</span></div>
      <label class="check"><input type="checkbox" data-setting="compaction.auto"${s.compaction.auto ? ' checked' : ''}><span>${escapeHtml(t('Compact automatically'))}<br><span class="muted">${escapeHtml(
        t("Past the threshold, the conversation is replaced by a handoff note: the model's summary plus the orchestrator's record of plan, changed files, your requests and supervisor corrections. Or type /compact."),
      )}</span></span></label>
      <div class="row"><span class="grow">${escapeHtml(t('Threshold'))}</span><input class="num wide" type="number" min="10000" step="10000" data-type="int" data-setting="compaction.thresholdTokens" value="${attr(String(s.compaction.thresholdTokens))}"><span class="muted">token</span></div>
    </div>
    <div class="card">
      <div class="card-head"><strong>${escapeHtml(t('Workspace'))}</strong></div>
      ${
        folders
          ? `<div class="row"><span class="grow">${escapeHtml(t('Folder the agent works in'))}</span><select id="folder" aria-label="${attr(t('Folder the agent works in'))}">${folders
              .map((f) => `<option value="${attr(f.path)}"${f.path === config?.folder ? ' selected' : ''} title="${attr(f.path)}">${escapeHtml(f.name)}</option>`)
              .join('')}</select></div>`
          : ''
      }
      ${
        config?.canOpenFolder
          ? `<div class="row"><span class="grow muted small">${escapeHtml(config.folder ?? t('No folder open.'))}</span><button class="btn" data-action="open-folder">${icon('folder')}${escapeHtml(t('Open folder…'))}</button></div>`
          : ''
      }
      <div class="row"><span class="grow"><strong>${escapeHtml(t('Project memory'))}</strong><br><span class="muted">${
        s.projectMemory === 'present'
          ? escapeHtml(t('.project-ai/ is set up; the agent reads it every task.'))
          : s.projectMemory === 'missing'
            ? escapeHtml(t('.project-ai/ is not set up in this folder.'))
            : escapeHtml(t('Open a folder first.'))
      }</span></span>${s.projectMemory === 'missing' ? `<button class="btn" data-action="init-memory">${escapeHtml(t('Initialize'))}</button>` : ''}</div>
      <label class="check"><input type="checkbox" data-setting="memory.learn"${s.learnLessons ? ' checked' : ''}><span>${escapeHtml(
        t('Learn from tasks'),
      )}<br><span class="muted">${escapeHtml(t('After a task that changed code, up to 3 lasting lessons (working commands, pitfalls, conventions) are added to .project-ai/lessons.md.'))}</span></span></label>
    </div>
    ${config?.ui ? appearanceCard(config.ui) : ''}
    ${config ? aboutCard(config.app) : ''}
    <div class="card">
      <div class="row"><span class="grow"><strong>${escapeHtml(t('Language'))}</strong><br><span class="muted small">${escapeHtml(
        t('Auto follows the machine: VS Code’s display language, otherwise the system language.'),
      )}</span></span>${select(
        'language',
        [
          ['auto', t('Auto (machine)')],
          ['en', 'English'],
          ['tr', 'Türkçe'],
        ],
        s.language,
        t('Language'),
      )}</div>
    </div>`;
}

/** Desktop: the window's theme and layout. */
function appearanceCard(appearance: NonNullable<ConfigView['ui']>): string {
  return `<div class="card">
      <div class="card-head"><strong>${escapeHtml(t('Appearance'))}</strong></div>
      <div class="row"><span class="grow">${escapeHtml(t('Theme'))}</span>${select(
        'desktop.theme',
        [
          ['system', t('Follow the system')],
          ['light', t('Light')],
          ['dark', t('Dark')],
        ],
        appearance.theme,
        t('Theme'),
      )}</div>
      <div class="row"><span class="grow">${escapeHtml(t('Layout'))}<br><span class="muted small">${escapeHtml(
        t('Sessions on the left and the plan and changes on the right, or everything in one column.'),
      )}</span></span>${select(
        'desktop.layout',
        [
          ['ide', t('Sessions and panels')],
          ['classic', t('Single column')],
        ],
        appearance.layout,
        t('Layout'),
      )}</div>
    </div>`;
}

/** Orka's version and the daily check for a newer release. */
function aboutCard(app: ConfigView['app']): string {
  const status = app.checking
    ? t('Checking…')
    : app.update
      ? t('Orka {version} is available.', { version: app.update.version })
      : app.error
        ? t('Could not check for a new Orka version: {error}', { error: app.error })
        : app.checkedAt
          ? t('Up to date (checked {when}).', { when: ago(new Date(app.checkedAt).toISOString()) })
          : '';
  return `<div class="card">
      <div class="card-head"><strong>Orka</strong><span class="muted">${escapeHtml(t('version {version}', { version: app.version }))}</span><span class="spacer"></span>
        <button class="btn small" data-action="check-app-update"${app.checking ? ' disabled' : ''}>${icon('refresh')}${escapeHtml(t('Check now'))}</button></div>
      ${
        status
          ? `<div class="hint${app.update ? ' ok' : !app.checking && app.error ? ' warn' : ''}"><span>${escapeHtml(status)}</span>${
              app.update ? `<button class="link" data-action="open-release">${escapeHtml(t('Download'))}</button>` : ''
            }</div>`
          : ''
      }
      <label class="check"><input type="checkbox" data-setting="updates.check"${app.checkUpdates ? ' checked' : ''}><span>${escapeHtml(t('Check for new versions'))}<br><span class="muted">${escapeHtml(
        t('Once a day Orka asks GitHub for its newest release. GitHub sees your IP address and Orka\'s version, nothing about your project.'),
      )}</span></span></label>
    </div>`;
}

function renderSettings(): void {
  el.settings.hidden = ui.view !== 'settings' || !config;
  if (el.settings.hidden || !config) return;
  // Keep scroll when settings re-render after a change.
  const scroll = el.settings.scrollTop;
  const tabs: Array<[SettingsTab, string]> = [
    ['agents', 'Agents'],
    ['providers', 'Providers'],
    ['skills', 'Skills'],
    ['mcp', 'MCP'],
    ['control', t('Control')],
  ];
  const body =
    ui.tab === 'agents' ? agentsHtml() : ui.tab === 'providers' ? providersTab(config.settings) : ui.tab === 'skills' ? skillsTab() : ui.tab === 'mcp' ? mcpTab() : controlTab(config.settings);
  el.settings.innerHTML = `
    <nav class="tabs" role="tablist">${tabs
      .map(([id, label]) => `<button role="tab" aria-selected="${ui.tab === id}" class="${ui.tab === id ? 'on' : ''}" data-action="tab" data-tab="${id}">${escapeHtml(label)}</button>`)
      .join('')}</nav>
    <div class="settings-body">${body}</div>`;
  el.settings.scrollTop = scroll;
}

function renderView(): void {
  const chat = ui.view === 'chat';
  renderHistory();
  el.plan.hidden = !chat || !session.plan?.steps.length;
  el.changes.hidden = !chat || !session.changes.length;
  el.transcript.hidden = !chat;
  el.composer.hidden = !chat;
  renderTopbar();
  renderAgentsPanel();
  renderSettings();
  renderUsage();
  if (chat) {
    renderPlan();
    renderChanges();
  }
  updateAside();
  renderStarters();
}

// ------------------------------------------------------------------ plan & changes

function renderPlan(): void {
  const plan: Plan | undefined = session.plan;
  el.plan.hidden = ui.view !== 'chat' || !plan?.steps.length;
  updateAside();
  if (el.plan.hidden || !plan) return;
  const done = plan.steps.filter((s) => s.status === 'completed').length;
  const pct = Math.round((100 * done) / plan.steps.length);
  const mark = (s: Plan['steps'][number]) =>
    s.status === 'completed' ? icon('check', 'ok') : s.status === 'in_progress' ? '<span class="spinner small"></span>' : '<span class="pending-dot"></span>';
  el.plan.innerHTML = `
    <div class="panel-head clickable" data-action="toggle-plan">
      <strong>${escapeHtml(t('Plan'))}</strong><span class="muted">${escapeHtml(t('{done} of {total} done', { done, total: plan.steps.length }))}</span><span class="spacer"></span>
      <span class="progress" aria-label="${attr(t('{n}% done', { n: pct }))}"><span data-width="${pct}"></span></span>
      <span class="chevron ${ui.planCollapsed ? 'collapsed' : ''}"></span>
    </div>
    ${
      ui.planCollapsed
        ? ''
        : `${plan.explanation ? `<p class="plan-explanation">${escapeHtml(plan.explanation)}</p>` : ''}
    <ol class="steps">${plan.steps.map((s) => `<li data-status="${attr(s.status)}">${mark(s)}<span>${escapeHtml(s.title)}</span></li>`).join('')}</ol>`
    }`;
  applyWidths(el.plan);
}

function hunksHtml(change: FileChange): string {
  const hunks = ui.hunks.get(change.absPath);
  if (!hunks) return `<div class="hunks"><span class="spinner small"></span></div>`;
  if (!hunks.length) return `<div class="hunks muted small">${escapeHtml(t('No differences.'))}</div>`;
  return `<div class="hunks">${hunks
    .map(
      (h, i) => `<div class="hunk">
      <div class="hunk-head"><span class="mono muted">${escapeHtml(h.header)}</span><span class="spacer"></span>
        <button class="link" data-action="keep-hunk" data-path="${attr(change.absPath)}" data-index="${i}" title="${attr(t('Keep this change'))}">${icon('check')}${escapeHtml(t('Keep'))}</button>
        <button class="link" data-action="revert-hunk" data-path="${attr(change.absPath)}" data-index="${i}" title="${attr(t('Undo only this part of the change'))}">${icon('undo')}${escapeHtml(t('Revert part'))}</button></div>
      <pre class="hunk-body mono">${h.lines.map((l) => `<span class="hl ${l.type === '+' ? 'add' : l.type === '-' ? 'del' : ''}">${escapeHtml(l.type)}${escapeHtml(l.text)}</span>`).join('\n')}${
        h.hidden ? `\n<span class="muted">${escapeHtml(t('… {n} more lines', { n: h.hidden }))}</span>` : ''
      }</pre>
    </div>`,
    )
    .join('')}</div>`;
}

function renderChanges(): void {
  const changes: FileChange[] = session.changes;
  el.changes.hidden = ui.view !== 'chat' || !changes.length;
  updateAside();
  if (el.changes.hidden) return;
  const badge = { added: 'A', modified: 'M', deleted: 'D' } as const;
  el.changes.innerHTML = `
    <div class="panel-head">
      <strong>${escapeHtml(t('Changes'))}</strong><span class="muted">${escapeHtml(tn('{n} file', '{n} files', changes.length))}</span><span class="spacer"></span>
      <button class="link" data-action="accept-all" title="${attr(t('Keep all changes'))}">${escapeHtml(t('Accept all'))}</button>
      <button class="link" data-action="revert-all" title="${attr(t('Undo all AI changes'))}">${escapeHtml(t('Revert all'))}</button>
    </div>
    <ul class="changes">${changes
      .map((c) => {
        const open = ui.hunks.has(c.absPath);
        const canSplit = c.status === 'modified';
        return `<li>
          <div class="change-row">
          ${
            canSplit
              ? `<button class="icon-btn hunk-toggle${open ? ' open' : ''}" data-action="toggle-hunks" data-path="${attr(c.absPath)}" aria-expanded="${open}" aria-label="${attr(t('Show changed parts'))}" title="${attr(t('Show changed parts'))}">${icon('chevron')}</button>`
              : '<span class="hunk-toggle-space"></span>'
          }
          <span class="badge ${attr(c.status)}">${escapeHtml(badge[c.status] ?? '')}</span>
          <button class="file" data-action="diff" data-path="${attr(c.absPath)}" title="${attr(t('Show diff'))}">${escapeHtml(c.relPath)}</button>
          ${c.added ? `<span class="stat add">+${Number(c.added) || 0}</span>` : ''}${c.removed ? `<span class="stat del">−${Number(c.removed) || 0}</span>` : ''}
          <button class="icon-btn" data-action="accept" data-path="${attr(c.absPath)}" aria-label="${attr(t('Accept'))}" title="${attr(t('Accept'))}">${icon('check')}</button>
          <button class="icon-btn" data-action="revert" data-path="${attr(c.absPath)}" aria-label="${attr(t('Revert'))}" title="${attr(t('Revert'))}">${icon('undo')}</button>
          </div>
          ${open && canSplit ? hunksHtml(c) : ''}
        </li>`;
      })
      .join('')}</ul>`;
}

/** After the change list moves, refresh the hunks of expanded files (and forget files that left the list). */
function refreshHunks(): void {
  for (const pathKey of [...ui.hunks.keys()]) {
    if (!session.changes.some((c) => c.absPath === pathKey && c.status === 'modified')) ui.hunks.delete(pathKey);
    else post({ type: 'getHunks', path: pathKey });
  }
}

// ------------------------------------------------------------------ transcript

function logoImg(): string {
  return `<img class="logo" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(orkaLogo)}" width="72" height="72" alt="Orka">`;
}

function renderEmptyState(): string {
  if (!config?.workspaceOpen) {
    if (!config?.canOpenFolder) {
      return `<div class="empty">${logoImg()}<h2>Orka</h2><p>${escapeHtml(t('Open a folder or workspace to start working with the agent.'))}</p></div>`;
    }
    const recent = config.folders ?? [];
    return `<div class="empty">${logoImg()}<h2>Orka</h2><p>${escapeHtml(t('Choose the project folder the agent works in.'))}</p>
      <button class="btn primary" data-action="open-folder">${icon('folder')}${escapeHtml(t('Open folder…'))}</button>
      ${
        recent.length
          ? `<div class="examples"><span class="muted small">${escapeHtml(t('Recent'))}</span>${recent
              .map((f) => `<button class="example" data-action="open-folder" data-path="${attr(f.path)}" title="${attr(f.path)}">${icon('folder')} ${escapeHtml(f.name)}</button>`)
              .join('')}</div>`
          : ''
      }</div>`;
  }
  // IDE layout: the examples are offered under the message box instead (renderStarters).
  const examples = layout === 'ide' ? [] : starterPrompts();
  const main = providerView(config.main.effective.provider);
  const sup = config.settings.supervisor.enabled ? shortModel(config.supervisor.effective.provider, config.supervisor.effective.model) : '';
  const skills = config.skillsEnabled ? config.skills.filter((s) => s.enabled).length : 0;
  return `<div class="empty">
    ${logoImg()}
    <h2>${escapeHtml(t('What should we build?'))}</h2>
    <p class="empty-intro">${escapeHtml(t('Describe a task. The agent studies your project, plans, edits files, runs builds and tests, and reports back.'))}${
      sup ? ` ${escapeHtml(t('A supervisor ({model}) watches its work and corrects it when needed.', { model: sup }))}` : ''
    }${skills ? ` ${escapeHtml(tn('{n} skill is ready (type /).', '{n} skills are ready (type /).', skills))}` : ''}</p>
    ${
      main && !main.ready
        ? `<div class="callout">${icon('key')}<span>${escapeHtml(t('Add an API key for {provider}, or pick another provider for the main agent.', { provider: main.label }))}</span><button class="btn primary" data-action="set-key" data-provider="${attr(main.kind)}">${escapeHtml(t('Add key'))}</button></div>`
        : ''
    }
    ${examples.length ? `<div class="examples">${examples.map((text) => `<button class="example" data-action="example" data-text="${attr(text)}">${escapeHtml(text)}</button>`).join('')}</div>` : ''}
  </div>`;
}

function itemHtml(item: TranscriptItem, nested: boolean): string {
  switch (item.kind) {
    case 'user': {
      if (nested) return '';
      const chips = [
        ...(item.images ?? []).map((img) =>
          img.thumb?.startsWith('data:image/')
            ? `<span class="chip image-chip" title="${attr(img.name)}"><img src="${attr(img.thumb)}" alt="${attr(img.name)}"></span>`
            : `<span class="chip">${icon('image')}<span class="ellipsis">${escapeHtml(img.name)}</span></span>`,
        ),
        ...(item.skills ?? []).map((s) => `<span class="chip skill">${icon('skill')}<span class="ellipsis">/${escapeHtml(s)}</span></span>`),
        ...(item.attachments ?? []).map((a) => `<span class="chip">${icon('read')}<span class="ellipsis">${escapeHtml(a)}</span></span>`),
      ];
      const rewind = session.running
        ? ''
        : `<button class="rewind" data-action="rewind" data-id="${attr(item.id)}" title="${attr(t('Go back to before this message (conversation and files) to change it'))}">${icon('undo')}${escapeHtml(t('Go back'))}</button>`;
      return `<div class="msg user" data-id="${attr(item.id)}"><div class="bubble">${escapeHtml(item.text)}</div>${chips.length ? `<div class="chips sent">${chips.join('')}</div>` : ''}${rewind}</div>`;
    }
    case 'assistant': {
      if (nested) return item.text.trim() ? `<div class="step-note" data-id="${attr(item.id)}">${renderMarkdown(item.text)}</div>` : '';
      const reasoning = item.reasoning.trim()
        ? `<details class="reasoning"${item.streaming && !item.text ? ' open' : ''}><summary>${escapeHtml(t('Thinking'))}</summary><div class="reasoning-body">${renderMarkdown(item.reasoning)}</div></details>`
        : '';
      const body = item.text
        ? `<div class="markdown">${renderMarkdown(item.text)}</div>`
        : item.streaming && !item.reasoning
          ? '<div class="typing"><span></span><span></span><span></span></div>'
          : '';
      // IDE layout: a finished reply can be copied as it was written (Markdown).
      const actions =
        layout === 'ide' && !item.streaming && item.text.trim()
          ? `<div class="msg-actions"><button class="icon-btn" data-action="copy-message" data-id="${attr(item.id)}" aria-label="${attr(t('Copy'))}" title="${attr(t('Copy'))}">${icon('copy')}</button></div>`
          : '';
      return `<div class="msg assistant${item.streaming ? ' streaming' : ''}" data-id="${attr(item.id)}">${reasoning}${body}${actions}</div>`;
    }
    case 'tool':
      if (nested && item.call.status !== 'awaiting_approval' && item.call.name !== 'run_subagent') return timelineRow(item);
      return `<div class="tool status-${attr(item.call.status)}${item.call.name === 'run_subagent' ? ' subagent' : ''}${item.call.name === 'ask_supervisor' ? ' ask-sup' : ''}${nested ? ' nested' : ''}" data-id="${attr(item.id)}" data-tool-id="${attr(item.id)}">${renderTool(item.call, item.liveOutput, item.sub)}</div>`;
    case 'notice':
      return `<div class="notice ${attr(item.level)}" data-id="${attr(item.id)}">${icon(item.level === 'info' ? 'info' : 'warn')}<span>${escapeHtml(item.message)}</span>${noticeAction(item.action)}</div>`;
    case 'supervisor':
      return supervisorHtml(item);
    case 'compaction':
      if (item.status === 'running') return `<div class="sup-line" data-id="${attr(item.id)}"><span class="spinner small"></span><span>${escapeHtml(t('Compacting the conversation…'))}</span></div>`;
      if (item.status === 'error') return `<div class="sup-line err" data-id="${attr(item.id)}">${icon('warn')}<span>${escapeHtml(t('Compaction failed: {error}', { error: item.message ?? '' }))}</span></div>`;
      return `<div class="notice info" data-id="${attr(item.id)}">${icon('info')}<span>${escapeHtml(
        t('Context compacted ({reason}): {before} → {after} tokens.', {
          reason: item.reason === 'auto' ? t('auto') : t('manual'),
          before: fmt(item.beforeTokens ?? 0),
          after: fmt(item.afterTokens ?? 0),
        }),
      )}</span></div>`;
  }
}

function supervisorHtml(item: Extract<TranscriptItem, { kind: 'supervisor' }>): string {
  const final = item.scope === 'final';
  if (item.status === 'intervened') {
    const state =
      item.scope === 'final' ? t('Not done yet') : item.scope === 'plan' ? t('Plan correction') : item.scope === 'step' ? t('Correction sent') : t('Guidance sent');
    const foot = final
      ? t('The main agent was sent back to work')
      : item.scope === 'step'
        ? t('Sent to the main agent with its next step')
        : t('Sent to the main agent before it continues');
    return `<div class="supervisor-card-msg" data-id="${attr(item.id)}">
      <div class="sup-head">${icon('eye', 'sup')}<span class="sup-label">SUPERVISOR</span>${item.model ? `<span class="muted small">${escapeHtml(item.model)}</span>` : ''}<span class="spacer"></span><span class="sup-state">${escapeHtml(state)}</span></div>
      ${item.reason ? `<div class="muted small">${escapeHtml(t('Why: {reason}', { reason: item.reason }))}</div>` : ''}
      <div class="sup-body markdown">${renderMarkdown(item.message ?? '')}</div>
      <div class="sup-foot">${icon('arrow')}<span>${escapeHtml(foot)}</span></div>
    </div>`;
  }
  const line = (cls: string, iconHtml: string, html: string) => `<div class="sup-line ${cls}" data-id="${attr(item.id)}">${iconHtml}<span>${html}</span></div>`;
  const reviewing: Record<typeof item.scope, string> = {
    step: t('Supervisor is reviewing this step…'),
    final: t('Supervisor is reviewing the result…'),
    plan: t('Supervisor is checking the plan…'),
    stuck: t('The agent seems stuck ({reason}); the supervisor is taking a look…', { reason: item.reason ?? '' }),
    progress: t('No progress for a while; the supervisor is checking the direction…'),
  };
  const approved: Record<typeof item.scope, string> = {
    step: t('Supervisor checked this step'),
    final: t('Supervisor approved the result'),
    plan: t('Supervisor approved the plan'),
    stuck: t('Supervisor checked the approach'),
    progress: t('Supervisor checked the direction'),
  };
  switch (item.status) {
    case 'reviewing':
      return line('', '<span class="spinner small"></span>', escapeHtml(reviewing[item.scope]));
    case 'ok':
      return line(
        'ok',
        icon('eye'),
        `${escapeHtml(approved[item.scope])} <span class="ok-text">· ${escapeHtml(t('on track'))}</span>${item.message ? ` — ${escapeHtml(item.message)}` : ''}`,
      );
    case 'error':
      return line('err', icon('warn'), escapeHtml(t('Supervisor unavailable: {error}', { error: item.message ?? t('unknown error') })));
    default:
      return line('muted', icon('dash'), escapeHtml(t('Supervisor review cancelled')));
  }
}

function noticeAction(action?: string): string {
  if (action?.startsWith('handoff:')) {
    const agent = config?.externalAgents?.find((a) => a.id === action.slice('handoff:'.length));
    return agent
      ? `<button class="btn primary small" data-action="handoff" data-agent="${attr(agent.id)}">${icon('handoff')}${escapeHtml(t('Continue in {agent}', { agent: agent.label }))}</button>`
      : '';
  }
  if (action === 'claudeUpdate') {
    const updating = config?.settings.claudeCode.updating;
    return `<button class="btn primary small" data-action="update-claude-code"${updating ? ' disabled' : ''}>${escapeHtml(updating ? t('Updating…') : t('Update Claude Code'))}</button>`;
  }
  if (!action?.startsWith('setApiKey')) return '';
  const provider = action.split(':')[1] ?? '';
  return `<button class="btn primary small" data-action="set-key" data-provider="${attr(provider)}">${escapeHtml(t('Add key'))}</button>`;
}

const STATUS_ICON: Record<ToolCallView['status'], string> = {
  running: '<span class="spinner small"></span>',
  awaiting_approval: icon('shield', 'warn'),
  done: icon('check', 'ok'),
  error: icon('x', 'err'),
  denied: icon('ban', 'err'),
  cancelled: icon('dash', 'muted'),
};

/** One compact line for a sub-agent's step. */
function timelineRow(item: Extract<TranscriptItem, { kind: 'tool' }>): string {
  const c = item.call;
  const summary = c.status === 'error' || c.status === 'denied' ? (c.output ?? '').split('\n')[0] : '';
  return `<div class="step status-${attr(c.status)}" data-id="${attr(item.id)}" data-tool-id="${attr(item.id)}">
    <span class="step-dot"></span><span class="step-title mono" title="${attr(c.title)}">${escapeHtml(c.title)}</span>
    ${summary ? `<span class="step-meta err ellipsis" title="${attr(summary)}">${escapeHtml(summary)}</span>` : ''}
    <span class="tool-status">${STATUS_ICON[c.status] ?? ''}</span></div>`;
}

function renderTool(call: ToolCallView, liveOutput: string, sub?: SubagentView): string {
  const output = call.output ?? liveOutput;
  if (call.name === 'run_subagent') return renderSubagent(call, sub);
  if (call.name === 'ask_supervisor') return renderSupervisorQuestion(call);
  const canDiff = call.path && (call.category === 'edit' || call.category === 'delete') && call.status === 'done';
  const headParts = `
      ${icon(toolIcon(call))}
      <span class="tool-title mono" title="${attr(call.title)}">${escapeHtml(call.title)}</span>
      ${canDiff ? `<button class="link" data-action="diff" data-path="${attr(call.path!)}">diff</button>` : ''}
      ${call.risk === 'dangerous' ? `<span class="risk">${escapeHtml(t('RISKY'))}</span>` : ''}
      <span class="tool-status" title="${attr(call.status)}">${STATUS_ICON[call.status] ?? ''}</span>`;
  const head = `<div class="tool-head">${headParts}</div>`;
  const shot = call.image?.startsWith('data:image/') ? `<img class="tool-shot" src="${attr(call.image)}" alt="${attr(t('Screenshot'))}">` : '';
  const showOutput = output && call.status !== 'awaiting_approval' && call.name !== 'update_plan';
  // IDE layout: one quiet line that opens to show the result (a running command shows its output).
  if (layout === 'ide' && call.status !== 'awaiting_approval') {
    if (!showOutput) return head + shot;
    return `<details class="tool-row"${call.status === 'running' && call.category === 'command' ? ' open' : ''}><summary class="tool-head">${headParts}</summary><pre class="mono">${escapeHtml(
      tail(output, 6000),
    )}</pre></details>${shot}`;
  }
  const outputBlock = showOutput
    ? `<details class="tool-output"${call.status === 'running' && call.category === 'command' ? ' open' : ''}><summary>${escapeHtml(
        call.status === 'running' ? t('Output') : call.status === 'error' || call.status === 'denied' ? t('Details') : t('Result'),
      )}</summary><pre class="mono">${escapeHtml(tail(output, 6000))}</pre></details>`
    : '';
  const approval =
    call.status === 'awaiting_approval'
      ? `<div class="approval">
          <strong class="approval-title">${escapeHtml(t('Approval needed'))}</strong>
          ${call.detail ? `<pre class="detail mono">${escapeHtml(call.detail)}</pre>` : ''}
          <label class="field"><span class="field-label">${escapeHtml(t('Note for the agent (optional)'))}</span>
            <input class="feedback" type="text" placeholder="${attr(t('e.g. do it differently: …'))}"></label>
          <div class="approval-buttons">
            <button class="btn primary" data-action="approve" data-id="${attr(call.id)}">${escapeHtml(t('Approve'))}</button>
            <button class="btn" data-action="deny" data-id="${attr(call.id)}">${escapeHtml(t('Deny'))}</button>
            ${call.hasPreview ? `<button class="link" data-action="preview" data-id="${attr(call.id)}">${escapeHtml(t('View diff'))}</button>` : ''}
            <label class="always-label"><input class="always" type="checkbox"> ${escapeHtml(t("Don't ask again"))}</label>
          </div>
        </div>`
      : '';
  return head + shot + approval + outputBlock;
}

/** The main agent asked the supervisor for help: its question and the advice it got. */
function renderSupervisorQuestion(call: ToolCallView): string {
  const answer = (call.output ?? '').replace(/^\[Supervisor advice[^\]]*\]\n/, '');
  const running = call.status === 'running';
  return `<div class="sup-head">${icon('eye', 'sup')}<span class="sup-label">${escapeHtml(t('Agent asked the supervisor'))}</span><span class="spacer"></span>
      <span class="tool-status" title="${attr(call.status)}">${STATUS_ICON[call.status] ?? ''}</span></div>
    <div class="sup-question">${escapeHtml(call.detail ?? '')}</div>
    ${running ? `<div class="muted small">${escapeHtml(t('Waiting for the supervisor…'))}</div>` : answer ? `<div class="sup-body markdown">${renderMarkdown(answer)}</div>` : ''}`;
}

function renderSubagent(call: ToolCallView, sub?: SubagentView): string {
  const colon = call.title.indexOf(': ');
  const agent = sub?.agent ?? (colon > 0 ? call.title.slice(0, colon) : 'sub-agent');
  const task = colon > 0 ? call.title.slice(colon + 2) : call.title;
  const steps = (sub?.items ?? []).map((i) => itemHtml(i, true)).filter(Boolean);
  const shown = steps.slice(-30);
  const hidden = steps.length - shown.length;
  const body = shown.length
    ? `<div class="steps-rail">${hidden ? `<div class="muted small">${escapeHtml(t('… {n} earlier steps', { n: hidden }))}</div>` : ''}${shown.join('')}</div>`
    : call.status === 'running'
      ? '<div class="steps-rail"><div class="typing"><span></span><span></span><span></span></div></div>'
      : '';
  const report =
    call.output && call.status !== 'running'
      ? `<details class="report"${call.status === 'done' ? ' open' : ''}><summary>${escapeHtml(call.status === 'done' ? t('REPORT') : t('RESULT'))}</summary><div class="markdown">${renderMarkdown(
          call.output.replace(/^\[[^\]]*\]\n/, ''),
        )}</div></details>`
      : '';
  const taskBlock = call.detail ? `<details class="task"><summary>${escapeHtml(t('Task'))}</summary><div class="markdown">${renderMarkdown(call.detail)}</div></details>` : '';
  return `<div class="tool-head">
      ${icon('agent', 'sub')}
      <span class="sub-name">${escapeHtml(agent)}</span>
      <span class="tool-title" title="${attr(task)}">${escapeHtml(task)}</span>
      ${sub?.model ? `<span class="model-tag" title="${attr(sub.model)}">${escapeHtml(sub.model)}${sub.usage ? ` · ${t('{n} tok', { n: fmt(totalTokens(sub.usage)) })}` : ''}</span>` : ''}
      <span class="tool-status" title="${attr(call.status)}">${STATUS_ICON[call.status] ?? ''}</span>
    </div>${body}${taskBlock}${report}`;
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

function nodeFor(item: TranscriptItem): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = itemHtml(item, false);
  const node = wrapper.firstElementChild as HTMLElement;
  node.querySelectorAll('.markdown pre').forEach((pre) => {
    const button = document.createElement('button');
    button.className = 'copy';
    button.dataset.action = 'copy';
    button.textContent = t('Copy');
    pre.appendChild(button);
  });
  return node;
}

function nearBottom(): boolean {
  const tr = el.transcript;
  return tr.scrollHeight - tr.scrollTop - tr.clientHeight < 80;
}

function scrollToBottom(): void {
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function renderTranscript(): void {
  const stick = nearBottom();
  el.transcript.innerHTML = '';
  renderStarters();
  if (!session.items.length) {
    el.transcript.innerHTML = renderEmptyState();
    updateToBottom();
    return;
  }
  for (const item of session.items) el.transcript.appendChild(nodeFor(item));
  if (stick) scrollToBottom();
  updateToBottom();
}

if (layout === 'ide') {
  el.transcript.addEventListener('scroll', updateToBottom, { passive: true });
  const toBottom = document.getElementById('to-bottom');
  if (toBottom) toBottom.innerHTML = icon('arrowDown');
}

function renderAll(): void {
  renderStatic();
  renderChrome();
  renderView();
  renderTranscript();
  renderSidebar();
}

/** Keep what the user typed/toggled (approval notes, open <details>) across a re-render. */
function transferState(from: HTMLElement, to: HTMLElement): void {
  const openStates = [...from.querySelectorAll('details')].map((d) => d.open);
  to.querySelectorAll('details').forEach((d, i) => {
    if (openStates[i] !== undefined) d.open = openStates[i];
  });
  const oldTools = [from, ...from.querySelectorAll<HTMLElement>('[data-tool-id]')].filter((n) => n.dataset.toolId);
  for (const oldTool of oldTools) {
    const selector = `[data-tool-id="${CSS.escape(oldTool.dataset.toolId!)}"]`;
    const newTool = to.matches(selector) ? to : to.querySelector<HTMLElement>(selector);
    if (!newTool) continue;
    const oldFeedback = oldTool.querySelector<HTMLInputElement>(':scope > .approval .feedback');
    const newFeedback = newTool.querySelector<HTMLInputElement>(':scope > .approval .feedback');
    if (oldFeedback && newFeedback) newFeedback.value = oldFeedback.value;
    const oldAlways = oldTool.querySelector<HTMLInputElement>(':scope > .approval .always');
    const newAlways = newTool.querySelector<HTMLInputElement>(':scope > .approval .always');
    if (oldAlways && newAlways) newAlways.checked = oldAlways.checked;
    if (oldTool.querySelector(':scope > .approval button:disabled')) {
      newTool.querySelectorAll<HTMLButtonElement>(':scope > .approval button').forEach((b) => (b.disabled = true));
    }
  }
}

// Incremental rendering: coalesce item updates into one DOM pass per animation frame.
const dirty = new Set<string>();
let fullRender = false;
let frame = 0;

function schedule(id?: string): void {
  if (id) dirty.add(id);
  else fullRender = true;
  if (!frame) frame = requestAnimationFrame(flush);
}

function flush(): void {
  frame = 0;
  if (fullRender) {
    fullRender = false;
    dirty.clear();
    renderAll();
    return;
  }
  const stick = nearBottom();
  if (el.transcript.querySelector('.empty') && session.items.length) {
    el.transcript.innerHTML = '';
    renderStarters();
  }
  for (const id of dirty) {
    const item = session.items.find((i) => i.id === id);
    if (!item) continue;
    const existing = el.transcript.querySelector<HTMLElement>(`:scope > [data-id="${CSS.escape(id)}"]`);
    const node = nodeFor(item);
    if (existing) {
      // Keep keyboard focus in an approval note that is being typed while the card re-renders.
      const focused = document.activeElement;
      const focusedTool = focused instanceof HTMLInputElement && existing.contains(focused) ? focused.closest<HTMLElement>('[data-tool-id]')?.dataset.toolId : undefined;
      transferState(existing, node);
      existing.replaceWith(node);
      if (focusedTool) {
        const selector = `[data-tool-id="${CSS.escape(focusedTool)}"]`;
        const tool = node.matches(selector) ? node : node.querySelector<HTMLElement>(selector);
        tool?.querySelector<HTMLInputElement>(':scope > .approval .feedback')?.focus();
      }
    } else {
      el.transcript.appendChild(node);
    }
  }
  dirty.clear();
  updateToBottom();
  if (stick) scrollToBottom();
}

function onEvent(event: AgentEvent): void {
  const changedId = applyEvent(session, event);
  // Sent messages offer "Go back" only while the agent is idle.
  document.body.classList.toggle('busy', session.running);
  switch (event.type) {
    case 'plan':
      renderPlan();
      break;
    case 'changes':
      refreshHunks();
      renderChanges();
      break;
    case 'phase':
    case 'run_started':
      renderTopbar();
      renderMeta();
      if (event.type === 'run_started') renderSidebar();
      break;
    case 'usage':
      renderMeta();
      renderUsage();
      if (layout === 'ide') renderTopbar();
      if (ui.agentsOpen && !el.agents.contains(document.activeElement)) renderAgentsPanel();
      break;
    case 'run_finished':
    case 'reset':
    case 'rewound':
      schedule();
      break;
    case 'user_message':
      // The first request names the session (header and session list).
      if (changedId) schedule(changedId);
      renderTopbar();
      renderSidebar();
      break;
    default:
      if (changedId) schedule(changedId);
  }
}

/**
 * Messages come from the app itself: the desktop bridge posts them to this page's own origin, VS
 * Code's webview host shares the vscode-webview origin, and the preview dispatches them directly
 * (no origin). Anything else (another window or frame) is ignored.
 */
function fromApp(e: MessageEvent): boolean {
  if (e.origin === '' || e.origin === window.location.origin) return true;
  return window.location.protocol === 'vscode-webview:' && e.origin.startsWith('vscode-webview://');
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  if (!fromApp(e)) return;
  const message = e.data;
  switch (message.type) {
    case 'dialog':
      showDialog(message.id, message.dialog);
      break;
    case 'closeDialog':
      closeDialog(message.id);
      break;
    case 'setInput':
      // Going back puts the message into the box again, to edit and resend.
      el.input.value = message.text;
      el.input.dispatchEvent(new Event('input'));
      el.input.focus();
      break;
    case 'init':
      session = message.session;
      document.body.classList.toggle('busy', session.running);
      config = message.config;
      ui.taskId = message.taskId;
      setLocale(config.locale);
      applyAppearance();
      ui.hunks.clear();
      renderAll();
      scrollToBottom();
      if (layout === 'ide') post({ type: 'listSessions' });
      break;
    case 'config': {
      // Don't clobber a settings field the user is typing into.
      const active = document.activeElement;
      const typing = active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type !== 'checkbox' && active.type !== 'radio');
      const languageChanged = message.config.locale !== getLocale();
      config = message.config;
      setLocale(config.locale);
      applyAppearance();
      if (languageChanged) {
        renderAll();
        break;
      }
      renderChrome();
      renderAgentsPanel();
      renderSidebar();
      if (!(typing && el.settings.contains(active))) renderSettings();
      if (!session.items.length) renderTranscript();
      break;
    }
    case 'sessions':
      ui.sessions = message.groups;
      ui.taskId = message.taskId;
      renderSidebar();
      break;
    case 'showAgents':
      ui.view = 'chat';
      ui.agentsOpen = true;
      renderView();
      break;
    case 'history':
      history = { tasks: message.tasks, currentId: message.currentId };
      renderHistory();
      break;
    case 'showHistory':
      openHistory();
      break;
    case 'fileMatches':
      if (composer.suggest?.kind === 'file') {
        composer.suggest.items = message.files.map((f) => ({ value: f, label: f }));
        composer.suggest.index = 0;
        renderSuggest();
      }
      break;
    case 'hunks':
      if (ui.hunks.has(message.path)) {
        ui.hunks.set(message.path, message.hunks);
        renderChanges();
      }
      break;
    case 'showSettings':
      ui.view = 'settings';
      if (message.tab) ui.tab = message.tab;
      if (ui.tab === 'skills') post({ type: 'reloadSkills' });
      renderView();
      break;
    case 'event':
      onEvent(message.event);
      break;
  }
});

renderAll();
autoGrow();
post({ type: 'ready' });
