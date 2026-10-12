import type { ApprovalRequest, ApprovalResponse, EditorContext, NodeHost, Orchestrator } from '@orka/core';
import type { FromWebview, ToWebview } from './protocol';
import type { AppSettings, Disposable, SettingsStore } from './settings';

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Fired when a key changed outside this app instance (another window). */
  onDidChange?(listener: (key: string) => void): Disposable;
}

export interface StateStore {
  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Promise<void>;
}

export interface PickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  /** A group heading, not selectable. */
  separator?: boolean;
}

export interface InputOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password?: boolean;
  /** Returns an error message for an invalid value. */
  validate?: (value: string) => string | undefined;
}

export interface Folder {
  name: string;
  path: string;
}

export interface TerminalHandle {
  show(): void;
}

/**
 * What the shared controller needs from the app it runs in: the VS Code extension (webview,
 * editor, native dialogs, secret storage) or the desktop app (browser window, in-app dialogs,
 * a settings file, the OS keychain).
 */
export interface AppShell {
  readonly kind: 'vscode' | 'desktop';
  readonly settings: SettingsStore;
  readonly secrets: SecretStore;
  /** Kept across sessions for this user. */
  readonly globalState: StateStore;
  /** Kept across sessions for the current folder. */
  readonly workspaceState: StateStore;
  readonly builtinSkillsDir: string;
  /** The surrounding app's display language (VS Code's), if it has one. */
  readonly appLanguage?: string;
  /** Private per-folder storage for task history and command snapshots. */
  storage(root: string): { tasks: string; snapshots: string };

  // ---- chat UI
  setMessageHandler(handler: (message: FromWebview) => void): void;
  post(message: ToWebview): void;
  readonly visible: boolean;
  reveal(): void;

  // ---- folders
  /** The folder the agent works in. */
  currentFolder(): Folder | undefined;
  /** Folders to offer in the folder picker (VS Code: a multi-root workspace; desktop: recent folders). */
  folders(): Folder[];
  /** Work in another folder; `path` empty = let the user choose one. Resolves true when it changed. */
  selectFolder(path?: string): Promise<boolean>;
  onDidChangeFolder(listener: () => void): Disposable;
  /** The user picks folders in the app itself (desktop). */
  readonly canOpenFolder: boolean;

  // ---- dialogs
  message(level: 'info' | 'warning' | 'error', text: string, options?: { modal?: boolean; detail?: string }, ...actions: string[]): Promise<string | undefined>;
  input(options: InputOptions): Promise<string | undefined>;
  /** Index of the picked item. */
  pick(items: PickItem[], options: { title?: string; matchOnDescription?: boolean }): Promise<number | undefined>;
  pickFile(options: { title: string; filters?: Record<string, string[]> }): Promise<string | undefined>;

  // ---- opening things
  openFile(absPath: string, options?: { preview?: boolean }): Promise<void>;
  /** A web page or a local file/folder with the system's default app. */
  openExternal(target: string): Promise<boolean>;
  openSettings(section?: 'all' | 'mcpServers'): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  /** Run a command in a visible terminal the user can type into; onClose when it is closed. */
  runInTerminal(options: { name: string; cwd: string; command: string; onClose?: () => void }): TerminalHandle;

  // ---- diffs
  openChangeDiff(absPath: string): Promise<void>;
  setApprovalPreview(id: string, preview: ApprovalRequest['preview']): void;
  clearApprovalPreview(id: string): void;
  openApprovalPreview(id: string): Promise<void>;

  // ---- the agent's environment
  createHost(options: { root: string; shell?: string; browserPath?: string; approve: (request: ApprovalRequest) => Promise<ApprovalResponse> }): NodeHost;
  editorContext(root: string): EditorContext;
  /** Workspace-relative paths of files whose name contains `query`. */
  findFiles(root: string, query: string, limit: number): Promise<string[]>;
  /** Changes to the user's skills folder or the workspace's .mcp.json. */
  watch(what: 'skills' | 'mcpConfig', listener: () => void): Disposable;

  // ---- hooks
  /** A new orchestrator (or none) is in use: e.g. inline review follows its changes. */
  attach(orchestrator: Orchestrator | undefined, settings: AppSettings): void;
  /** Settings were read again. */
  settingsChanged?(settings: AppSettings): void;
  /** Running state and a one-line summary of the agents (status bar). */
  status?(status: { running: boolean; text: string; tooltip: string }): void;
  /** A short notification outside the chat (e.g. a finished background update). */
  notify?(text: string): void;
}
