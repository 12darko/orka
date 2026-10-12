import { type ApprovalRequest, type ApprovalResponse, copyToClipboard, type EditorContext, NodeHost, type Orchestrator, t, unifiedDiff } from '@orka/core';
import type { AppSettings, AppShell, DialogView, Disposable, Folder, FromWebview, InputOptions, PickItem, StateStore, TerminalHandle, ToWebview } from '@orka/app';
import { findFilesByName, USER_SKILLS_DIR } from '@orka/app';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, type FSWatcher, mkdirSync, promises as fs, statSync, watch } from 'node:fs';
import * as path from 'node:path';
import { openExternal, openTerminalWindow, pickFile, pickFolder } from './native';
import { OsSecretStore } from './secrets';
import type { UiServer } from './server';
import { JsonSettings, JsonState } from './store';

const RECENT_STATE = 'recentFolders';
const MAX_RECENT = 8;

/** Same key as the CLI, so both see the same task history and snapshots for a folder. */
export function folderKey(root: string): string {
  return createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * The desktop side of Orka: the chat UI in its own window (served by UiServer), questions asked
 * inside the UI, the OS folder picker and keychain, a settings file, and task history in ~/.orka.
 */
export class DesktopShell implements AppShell, Disposable {
  readonly kind = 'desktop' as const;
  readonly canOpenFolder = true;
  readonly settings: JsonSettings;
  readonly secrets: OsSecretStore;
  readonly globalState: StateStore;
  readonly workspaceState: StateStore;
  readonly builtinSkillsDir: string;
  private readonly state: JsonState;
  private folder?: string;
  private handler: (message: FromWebview) => void = () => {};
  private readonly dialogs = new Map<string, { dialog: DialogView; resolve: (value: string | number | undefined) => void }>();
  private readonly previews = new Map<string, NonNullable<ApprovalRequest['preview']>>();
  private readonly folderListeners = new Set<() => void>();
  private orchestrator?: Orchestrator;

  constructor(
    private readonly home: string,
    private readonly server: UiServer,
    options: { folder?: string; skillsDir: string },
  ) {
    const dir = path.join(home, 'desktop');
    this.settings = new JsonSettings(path.join(dir, 'settings.json'));
    this.secrets = new OsSecretStore(path.join(dir, 'keys.json'));
    this.state = new JsonState(path.join(dir, 'state.json'));
    this.globalState = this.state.scope('global');
    this.builtinSkillsDir = options.skillsDir;
    // Per-folder state (e.g. whether the folder's .mcp.json is trusted) follows the open folder.
    this.workspaceState = {
      get: <T>(key: string, fallback?: T) => this.folderState().get<T>(key, fallback as T),
      update: (key: string, value: unknown) => this.folderState().update(key, value),
    } as StateStore;
    const start = options.folder ?? this.globalState.get<string>('lastFolder');
    if (start && isDirectory(start)) this.useFolder(start);
  }

  private folderState(): StateStore {
    return this.state.scope(this.folder ? `folder:${folderKey(this.folder)}` : 'folder:none');
  }

  storage(root: string): { tasks: string; snapshots: string } {
    const key = folderKey(root);
    return { tasks: path.join(this.home, 'tasks', key), snapshots: path.join(this.home, 'snapshots', `${key}.git`) };
  }

  // ---------------------------------------------------------------- chat UI

  setMessageHandler(handler: (message: FromWebview) => void): void {
    this.handler = handler;
  }

  /** A message from the page: answers to dialogs stay here, everything else goes to the controller. */
  receive(message: FromWebview): void {
    if (message.type === 'dialogResult') {
      const open = this.dialogs.get(message.id);
      if (!open) return;
      this.dialogs.delete(message.id);
      open.resolve(message.value);
      return;
    }
    this.handler(message);
  }

  /** A page (re)connected: questions still open are asked again. */
  resendDialogs(): void {
    for (const [id, { dialog }] of this.dialogs) this.server.post({ type: 'dialog', id, dialog });
  }

  post(message: ToWebview): void {
    this.server.post(message);
  }

  get visible(): boolean {
    return this.server.connected;
  }

  reveal(): void {
    /* the window is the app */
  }

  // ---------------------------------------------------------------- folders

  currentFolder(): Folder | undefined {
    return this.folder ? { name: path.basename(this.folder) || this.folder, path: this.folder } : undefined;
  }

  folders(): Folder[] {
    return this.recent().map((p) => ({ name: path.basename(p) || p, path: p }));
  }

  async selectFolder(fsPath?: string): Promise<boolean> {
    const target = fsPath ?? (await pickFolder(t('Choose the project folder the agent works in.')));
    if (!target) return false;
    if (!isDirectory(target)) {
      void this.message('warning', t('Not a folder: {path}', { path: target }));
      await this.globalState.update(
        RECENT_STATE,
        this.recent().filter((p) => p !== target),
      );
      return false;
    }
    if (this.folder && path.resolve(target) === path.resolve(this.folder)) return false;
    this.useFolder(target);
    for (const listener of this.folderListeners) listener();
    return true;
  }

  private useFolder(folder: string): void {
    this.folder = path.resolve(folder);
    const recent = [this.folder, ...this.recent().filter((p) => path.resolve(p) !== this.folder)].slice(0, MAX_RECENT);
    void this.globalState.update(RECENT_STATE, recent);
    void this.globalState.update('lastFolder', this.folder);
    this.watchMcpConfig();
  }

  private recent(): string[] {
    return (this.globalState.get<string[]>(RECENT_STATE, []) ?? []).filter((p) => typeof p === 'string' && isDirectory(p));
  }

  onDidChangeFolder(listener: () => void): Disposable {
    this.folderListeners.add(listener);
    return { dispose: () => this.folderListeners.delete(listener) };
  }

  // ---------------------------------------------------------------- dialogs (asked inside the UI)

  private ask(dialog: DialogView): Promise<string | number | undefined> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.dialogs.set(id, { dialog, resolve });
      this.server.post({ type: 'dialog', id, dialog });
    });
  }

  async message(level: 'info' | 'warning' | 'error', text: string, options: { modal?: boolean; detail?: string } = {}, ...actions: string[]): Promise<string | undefined> {
    // Errors also go to the terminal the app was started from, where they outlive the in-window notice.
    if (level === 'error') console.error(`[orka] ${text}${options.detail ? `\n${options.detail}` : ''}`);
    const answer = this.ask({ kind: 'message', level, text, detail: options.detail, modal: !!options.modal, actions });
    // A notice without choices does not hold anyone up.
    if (!options.modal && !actions.length) return undefined;
    const value = await answer;
    return typeof value === 'string' && actions.includes(value) ? value : undefined;
  }

  async input(options: InputOptions): Promise<string | undefined> {
    let value = options.value;
    let error: string | undefined;
    for (;;) {
      const answer = await this.ask({ kind: 'input', title: options.title, prompt: options.prompt, placeholder: options.placeHolder, value, password: options.password, error });
      if (typeof answer !== 'string') return undefined;
      error = options.validate?.(answer);
      if (!error) return answer;
      value = answer;
    }
  }

  async pick(items: PickItem[], options: { title?: string }): Promise<number | undefined> {
    const answer = await this.ask({ kind: 'pick', title: options.title, items });
    return typeof answer === 'number' && Number.isInteger(answer) && items[answer] && !items[answer].separator ? answer : undefined;
  }

  pickFile(options: { title: string; filters?: Record<string, string[]> }): Promise<string | undefined> {
    return pickFile(options.title, options.filters);
  }

  // ---------------------------------------------------------------- opening things

  async openFile(absPath: string): Promise<void> {
    if (!(await openExternal(absPath))) void this.message('warning', t('Could not open {file}.', { file: absPath }));
  }

  openExternal(target: string): Promise<boolean> {
    return openExternal(target);
  }

  async openSettings(section: 'all' | 'mcpServers' = 'all'): Promise<void> {
    if (section === 'all') {
      this.post({ type: 'showSettings' });
      return;
    }
    // MCP servers are edited as JSON, like in VS Code's settings.json.
    this.settings.ensureFile({ mcpServers: {} });
    await this.openFile(this.settings.file);
  }

  async writeClipboard(text: string): Promise<void> {
    copyToClipboard(text);
  }

  runInTerminal(options: { name: string; cwd: string; command: string; onClose?: () => void }): TerminalHandle {
    openTerminalWindow({ title: options.name, cwd: options.cwd, command: options.command, onClose: options.onClose });
    return { show: () => undefined };
  }

  // ---------------------------------------------------------------- diffs (shown inside the UI)

  async openChangeDiff(absPath: string): Promise<void> {
    const changes = this.orchestrator?.changes;
    if (!changes || !this.folder) return;
    const original = changes.getOriginal(absPath) ?? null;
    const current = await fs.readFile(absPath, 'utf8').catch(() => null);
    const rel = path.relative(this.folder, absPath).split(path.sep).join('/');
    const label = original === null ? t('new file') : current === null ? t('deleted') : t('AI changes');
    await this.ask({ kind: 'diff', title: `${rel} (${label})`, diff: unifiedDiff(rel, original, current) });
  }

  setApprovalPreview(id: string, preview: ApprovalRequest['preview']): void {
    if (preview) this.previews.set(id, preview);
  }

  clearApprovalPreview(id: string): void {
    this.previews.delete(id);
  }

  async openApprovalPreview(id: string): Promise<void> {
    const preview = this.previews.get(id);
    if (!preview) return;
    const rel = this.folder ? path.relative(this.folder, preview.path).split(path.sep).join('/') : preview.path;
    await this.ask({ kind: 'diff', title: `${rel} (${t('proposed change')})`, diff: unifiedDiff(rel, preview.before, preview.after) });
  }

  // ---------------------------------------------------------------- the agent's environment

  createHost(options: { root: string; shell?: string; browserPath?: string; approve: (request: ApprovalRequest) => Promise<ApprovalResponse> }): NodeHost {
    return new NodeHost({ workspaceRoot: options.root, shell: options.shell, approve: options.approve, browserPath: options.browserPath, editorName: 'Orka Desktop' });
  }

  editorContext(): EditorContext {
    return {};
  }

  findFiles(root: string, query: string, limit: number): Promise<string[]> {
    return findFilesByName(root, query, limit);
  }

  private readonly watchers = { skills: new Set<() => void>(), mcpConfig: new Set<() => void>() };
  private skillsWatcher?: FSWatcher;
  private mcpWatcher?: FSWatcher;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  watch(what: 'skills' | 'mcpConfig', listener: () => void): Disposable {
    this.watchers[what].add(listener);
    if (what === 'skills' && !this.skillsWatcher) {
      try {
        mkdirSync(USER_SKILLS_DIR, { recursive: true });
        this.skillsWatcher = watch(USER_SKILLS_DIR, { recursive: true }, (_e, name) => {
          if (!name || /\.md$/i.test(String(name))) this.fire('skills');
        });
      } catch {
        /* skills are also reloaded when a task starts */
      }
    }
    return { dispose: () => this.watchers[what].delete(listener) };
  }

  private watchMcpConfig(): void {
    this.mcpWatcher?.close();
    this.mcpWatcher = undefined;
    if (!this.folder) return;
    try {
      this.mcpWatcher = watch(this.folder, (_e, name) => {
        if (String(name) === '.mcp.json') this.fire('mcpConfig');
      });
    } catch {
      /* the file is read again when a task starts */
    }
  }

  private fire(what: 'skills' | 'mcpConfig'): void {
    clearTimeout(this.timers.get(what));
    this.timers.set(
      what,
      setTimeout(() => {
        for (const listener of this.watchers[what]) listener();
      }, 250),
    );
  }

  // ---------------------------------------------------------------- hooks

  attach(orchestrator: Orchestrator | undefined, _settings: AppSettings): void {
    this.orchestrator = orchestrator;
  }

  notify(text: string): void {
    void this.message('info', text);
  }

  dispose(): void {
    for (const { resolve } of this.dialogs.values()) resolve(undefined);
    this.dialogs.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.skillsWatcher?.close();
    this.mcpWatcher?.close();
    this.settings.dispose();
  }
}

function isDirectory(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}
