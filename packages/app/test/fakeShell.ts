// An AppShell for tests: settings, state and secrets in memory, folders on disk, and every message
// to the UI and every question to the user recorded.
import { type ApprovalRequest, type ApprovalResponse, type EditorContext, NodeHost } from '@orka/core';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ToWebview } from '../src/protocol';
import type { Disposable, SettingsStore } from '../src/settings';
import type { AppShell, Folder, SecretStore, StateStore, TerminalHandle } from '../src/shell';

export class MemorySettings implements SettingsStore {
  private readonly listeners = new Set<() => void>();

  constructor(readonly data: Record<string, unknown> = {}) {}

  get<T>(key: string, fallback: T): T {
    return (this.data[key] ?? fallback) as T;
  }

  isSet(key: string): boolean {
    return this.data[key] !== undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data[key] = value;
    for (const listener of this.listeners) listener();
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}

export class MemoryState implements StateStore {
  readonly data = new Map<string, unknown>();

  get<T>(key: string, fallback?: T): T {
    return (this.data.has(key) ? this.data.get(key) : fallback) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

class MemorySecrets implements SecretStore {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export class FakeShell implements AppShell {
  readonly settings: MemorySettings;
  readonly secrets = new MemorySecrets();
  readonly globalState = new MemoryState();
  readonly workspaceState = new MemoryState();
  readonly builtinSkillsDir: string;
  readonly canOpenFolder: boolean;
  readonly visible = true;
  readonly posted: ToWebview[] = [];
  readonly asked: Array<{ level: string; text: string; actions: string[] }> = [];
  readonly opened: string[] = [];
  /** The action message() answers with, when it offers it. */
  answer?: string;
  private folder?: string;
  private readonly folderListeners = new Set<() => void>();

  constructor(
    readonly kind: 'vscode' | 'desktop',
    private readonly home: string,
    /** Recent folders (desktop) or workspace folders (VS Code); the first one is open. */
    private readonly recent: string[],
    settings: Record<string, unknown> = {},
  ) {
    this.settings = new MemorySettings({ language: 'en', ...settings });
    this.builtinSkillsDir = path.join(home, 'builtin-skills');
    this.canOpenFolder = kind === 'desktop';
    this.folder = recent[0];
  }

  /** The newest message of this type sent to the UI. */
  last<T extends ToWebview['type']>(type: T): Extract<ToWebview, { type: T }> | undefined {
    return this.posted.filter((m): m is Extract<ToWebview, { type: T }> => m.type === type).at(-1);
  }

  storage(root: string): { tasks: string; snapshots: string } {
    const key = createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 12);
    return { tasks: path.join(this.home, 'tasks', key), snapshots: path.join(this.home, 'snapshots', `${key}.git`) };
  }

  setMessageHandler(): void {}

  post(message: ToWebview): void {
    this.posted.push(message);
  }

  reveal(): void {}

  currentFolder(): Folder | undefined {
    return this.folder ? { name: path.basename(this.folder), path: this.folder } : undefined;
  }

  folders(): Folder[] {
    return this.recent.map((p) => ({ name: path.basename(p), path: p }));
  }

  async selectFolder(fsPath?: string): Promise<boolean> {
    if (!fsPath || fsPath === this.folder) return false;
    this.folder = fsPath;
    for (const listener of this.folderListeners) listener();
    return true;
  }

  onDidChangeFolder(listener: () => void): Disposable {
    this.folderListeners.add(listener);
    return { dispose: () => this.folderListeners.delete(listener) };
  }

  async message(level: 'info' | 'warning' | 'error', text: string, _options?: unknown, ...actions: string[]): Promise<string | undefined> {
    this.asked.push({ level, text, actions });
    return this.answer !== undefined && actions.includes(this.answer) ? this.answer : undefined;
  }

  async input(): Promise<string | undefined> {
    return undefined;
  }

  async pick(): Promise<number | undefined> {
    return undefined;
  }

  async pickFile(): Promise<string | undefined> {
    return undefined;
  }

  async openFile(): Promise<void> {}

  async openExternal(target: string): Promise<boolean> {
    this.opened.push(target);
    return true;
  }

  async openSettings(): Promise<void> {}

  async writeClipboard(): Promise<void> {}

  runInTerminal(): TerminalHandle {
    return { show: () => undefined };
  }

  async openChangeDiff(): Promise<void> {}

  setApprovalPreview(): void {}

  clearApprovalPreview(): void {}

  async openApprovalPreview(): Promise<void> {}

  createHost(options: { root: string; approve: (request: ApprovalRequest) => Promise<ApprovalResponse> }): NodeHost {
    return new NodeHost({ workspaceRoot: options.root, approve: options.approve });
  }

  editorContext(): EditorContext {
    return {};
  }

  async findFiles(): Promise<string[]> {
    return [];
  }

  watch(): Disposable {
    return { dispose: () => undefined };
  }

  attach(): void {}
}
