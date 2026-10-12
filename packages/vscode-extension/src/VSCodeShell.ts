import type { ApprovalRequest, ApprovalResponse, EditorContext, NodeHost, Orchestrator } from '@orka/core';
import type { AppSettings, AppShell, Folder, FromWebview, InputOptions, PickItem, SecretStore, StateStore, TerminalHandle, ToWebview } from '@orka/app';
import { USER_SKILLS_DIR } from '@orka/app';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentTerminal } from './AgentTerminal';
import { ChatViewProvider } from './ChatViewProvider';
import { VSCodeSettings } from './config';
import { DiffService } from './DiffService';
import { InlineReview } from './InlineReview';
import { VSCodeHost } from './VSCodeHost';

const FOLDER_STATE = 'orka.folder';

/** The VS Code side of Orka: the chat webview, native dialogs, secret storage, diff editor, terminals and status bar. */
export class VSCodeShell implements AppShell, vscode.Disposable {
  readonly kind = 'vscode' as const;
  readonly settings = new VSCodeSettings();
  readonly secrets: SecretStore;
  readonly globalState: StateStore;
  readonly workspaceState: StateStore;
  readonly canOpenFolder = false;
  readonly view: ChatViewProvider;
  private handler: (message: FromWebview) => void = () => {};
  private orchestrator?: Orchestrator;
  private appSettings?: AppSettings;
  private readonly terminal = new AgentTerminal();
  private readonly diff: DiffService;
  private readonly inlineReview: InlineReview;
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly folderChanged = new vscode.EventEmitter<void>();
  /** Terminals opened with runInTerminal that want to hear when they close. */
  private readonly terminalClosers = new Map<vscode.Terminal, () => void>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.secrets = {
      get: (key) => Promise.resolve(context.secrets.get(key)),
      store: (key, value) => Promise.resolve(context.secrets.store(key, value)),
      delete: (key) => Promise.resolve(context.secrets.delete(key)),
      onDidChange: (listener) => context.secrets.onDidChange((e) => listener(e.key)),
    };
    this.globalState = stateStore(context.globalState);
    this.workspaceState = stateStore(context.workspaceState);
    this.view = new ChatViewProvider(context.extensionUri, (m) => this.handler(m));
    this.diff = new DiffService(() => {
      if (!this.orchestrator) throw new Error('No workspace folder is open.');
      return this.orchestrator.changes;
    });
    this.inlineReview = new InlineReview(
      () => this.orchestrator?.changes,
      () => this.appSettings?.inlineReview ?? true,
    );
    this.statusBar.command = 'orka.configureAgents';
    this.statusBar.show();
    this.disposables.push(
      this.terminal,
      this.diff,
      this.inlineReview,
      this.statusBar,
      this.folderChanged,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.folderChanged.fire()),
      vscode.window.onDidCloseTerminal((terminal) => {
        const onClose = this.terminalClosers.get(terminal);
        if (!onClose) return;
        this.terminalClosers.delete(terminal);
        onClose();
      }),
    );
  }

  get builtinSkillsDir(): string {
    return path.join(this.context.extensionPath, 'dist', 'skills');
  }

  get appLanguage(): string {
    return vscode.env.language;
  }

  storage(root: string): { tasks: string; snapshots: string } {
    const hash = createHash('sha1').update(root).digest('hex').slice(0, 12);
    return {
      tasks: this.context.storageUri ? path.join(this.context.storageUri.fsPath, 'tasks') : path.join(this.context.globalStorageUri.fsPath, 'tasks', hash),
      snapshots: path.join(this.context.globalStorageUri.fsPath, 'snapshots', `${hash}.git`),
    };
  }

  // ---------------------------------------------------------------- chat view

  setMessageHandler(handler: (message: FromWebview) => void): void {
    this.handler = handler;
  }

  post(message: ToWebview): void {
    this.view.post(message);
  }

  get visible(): boolean {
    return this.view.visible;
  }

  reveal(): void {
    this.view.reveal();
  }

  // ---------------------------------------------------------------- folders

  /** The folder the agent works in: the remembered one in a multi-root workspace, else the first. */
  currentFolder(): Folder | undefined {
    const folders = this.folders();
    const remembered = this.context.workspaceState.get<string>(FOLDER_STATE);
    return folders.find((f) => f.path === remembered) ?? folders[0];
  }

  folders(): Folder[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
  }

  async selectFolder(fsPath?: string): Promise<boolean> {
    const folder = this.folders().find((f) => f.path === fsPath);
    if (!folder || folder.path === this.currentFolder()?.path) return false;
    await this.context.workspaceState.update(FOLDER_STATE, folder.path);
    this.folderChanged.fire();
    return true;
  }

  onDidChangeFolder(listener: () => void): vscode.Disposable {
    return this.folderChanged.event(listener);
  }

  // ---------------------------------------------------------------- dialogs

  async message(level: 'info' | 'warning' | 'error', text: string, options: { modal?: boolean; detail?: string } = {}, ...actions: string[]): Promise<string | undefined> {
    const show = level === 'error' ? vscode.window.showErrorMessage : level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    return show(text, { modal: options.modal, detail: options.detail }, ...actions);
  }

  input(options: InputOptions): Promise<string | undefined> {
    return Promise.resolve(
      vscode.window.showInputBox({
        title: options.title,
        prompt: options.prompt,
        placeHolder: options.placeHolder,
        value: options.value,
        password: options.password,
        ignoreFocusOut: true,
        validateInput: options.validate,
      }),
    );
  }

  async pick(items: PickItem[], options: { title?: string; matchOnDescription?: boolean }): Promise<number | undefined> {
    type Item = vscode.QuickPickItem & { index: number };
    const quickItems: Item[] = items.map((item, index) =>
      item.separator
        ? { label: item.label, kind: vscode.QuickPickItemKind.Separator, index }
        : { label: item.label, description: item.description, detail: item.detail, picked: item.picked, index },
    );
    const picked = await vscode.window.showQuickPick(quickItems, { title: options.title, matchOnDescription: options.matchOnDescription });
    return picked?.index;
  }

  async pickFile(options: { title: string; filters?: Record<string, string[]> }): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({ title: options.title, canSelectMany: false, filters: options.filters });
    return picked?.[0]?.fsPath;
  }

  // ---------------------------------------------------------------- opening things

  async openFile(absPath: string, options: { preview?: boolean } = {}): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(absPath), { preview: options.preview ?? false });
  }

  openExternal(target: string): Promise<boolean> {
    return Promise.resolve(vscode.env.openExternal(/^https?:\/\//i.test(target) ? vscode.Uri.parse(target) : vscode.Uri.file(target)));
  }

  async openSettings(section: 'all' | 'mcpServers' = 'all'): Promise<void> {
    if (section === 'mcpServers') {
      await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'orka.mcpServers' } });
    } else {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.context.extension.id}`);
    }
  }

  async writeClipboard(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
  }

  runInTerminal(options: { name: string; cwd: string; command: string; onClose?: () => void }): TerminalHandle {
    const terminal = vscode.window.createTerminal({ name: options.name, cwd: options.cwd, iconPath: new vscode.ThemeIcon('rocket') });
    if (options.onClose) this.terminalClosers.set(terminal, options.onClose);
    terminal.sendText(options.command);
    return { show: () => terminal.show() };
  }

  // ---------------------------------------------------------------- diffs

  openChangeDiff(absPath: string): Promise<void> {
    return this.diff.openChangeDiff(absPath);
  }

  setApprovalPreview(id: string, preview: ApprovalRequest['preview']): void {
    this.diff.setPreview(id, preview);
  }

  clearApprovalPreview(id: string): void {
    this.diff.clearPreview(id);
  }

  openApprovalPreview(id: string): Promise<void> {
    return this.diff.openApprovalPreview(id);
  }

  // ---------------------------------------------------------------- the agent's environment

  createHost(options: { root: string; shell?: string; browserPath?: string; approve: (request: ApprovalRequest) => Promise<ApprovalResponse> }): NodeHost {
    return new VSCodeHost(options.root, options.shell, this.terminal, options.approve, options.browserPath);
  }

  editorContext(root: string): EditorContext {
    const rel = (uri: vscode.Uri) => {
      const r = path.relative(root, uri.fsPath);
      return r.startsWith('..') || path.isAbsolute(r) ? undefined : r.split(path.sep).join('/');
    };
    const context: EditorContext = {};
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      context.activeFile = rel(editor.document.uri);
      const sel = editor.selection;
      if (context.activeFile && !sel.isEmpty) {
        context.selection = { startLine: sel.start.line + 1, endLine: sel.end.line + 1, text: editor.document.getText(sel) };
      }
    }
    const open = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const r = rel(tab.input.uri);
          if (r) open.add(r);
        }
      }
    }
    context.openFiles = [...open];
    const problems: string[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      const r = rel(uri);
      if (!r) continue;
      for (const d of diagnostics) {
        if (d.severity !== vscode.DiagnosticSeverity.Error) continue;
        problems.push(`${r}:${d.range.start.line + 1}: ${d.source ? `${d.source}: ` : ''}${d.message.split('\n')[0]}`);
      }
    }
    context.problems = problems;
    return context;
  }

  async findFiles(root: string, query: string, limit: number): Promise<string[]> {
    const files = await vscode.workspace.findFiles(
      `**/*${query}*`,
      '{**/node_modules/**,**/.git/**,**/Library/**,**/obj/**,**/bin/**,**/dist/**,**/out/**}',
      limit,
    );
    return files
      .map((f) => path.relative(root, f.fsPath))
      .filter((r) => !r.startsWith('..') && !path.isAbsolute(r))
      .map((r) => r.split(path.sep).join('/'));
  }

  watch(what: 'skills' | 'mcpConfig', listener: () => void): vscode.Disposable {
    const watcher =
      what === 'skills'
        ? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(USER_SKILLS_DIR), '**/*.md'))
        : vscode.workspace.createFileSystemWatcher('**/.mcp.json');
    const subscriptions = [watcher, watcher.onDidCreate(listener), watcher.onDidChange(listener), watcher.onDidDelete(listener)];
    return { dispose: () => subscriptions.forEach((d) => d.dispose()) };
  }

  // ---------------------------------------------------------------- hooks

  attach(orchestrator: Orchestrator | undefined, settings: AppSettings): void {
    this.orchestrator = orchestrator;
    this.appSettings = settings;
    this.inlineReview.attach();
  }

  settingsChanged(settings: AppSettings): void {
    this.appSettings = settings;
    this.inlineReview.attach();
  }

  status(status: { running: boolean; text: string; tooltip: string }): void {
    this.statusBar.text = `${status.running ? '$(sync~spin)' : '$(hubot)'} ${status.text}`;
    this.statusBar.tooltip = status.tooltip;
  }

  notify(text: string): void {
    void vscode.window.showInformationMessage(text);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function stateStore(memento: vscode.Memento): StateStore {
  return {
    get: <T>(key: string, fallback?: T) => memento.get<T>(key, fallback as T),
    update: (key: string, value: unknown) => Promise.resolve(memento.update(key, value)),
  };
}
