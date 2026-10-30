import {
  type AgentEvent,
  type AIProvider,
  type ApprovalRequest,
  type ApprovalResponse,
  applyEvent,
  checkAppUpdate,
  createProvider,
  DEFAULT_SUBAGENTS,
  describeModel,
  emptySession,
  EXTERNAL_AGENTS,
  externalAgent,
  FileTaskStore,
  findExecutable,
  getLocale,
  Handoff,
  handoffBrief,
  hunkHeader,
  inferModel,
  initProjectMemory,
  isChatModelId,
  isNewerVersion,
  lineText,
  listModels,
  loadSkills,
  hasHooks,
  type HooksConfig,
  McpManager,
  type McpServerConfig,
  MODEL_CATALOG,
  type ModelInfo,
  type NodeHost,
  newTaskId,
  NO_HOOKS,
  type OrchestratorSettings,
  normalizeLocale,
  Orchestrator,
  PermissionManager,
  type PermissionMode,
  type ProviderConfig,
  PROVIDER_KINDS,
  PROVIDER_PRESETS,
  PROVIDERS,
  type ProviderKind,
  releasePageUrl,
  resolveClaudeExecutable,
  type SessionView,
  setLocale,
  ShadowGit,
  type Skill,
  SKILL_NAME,
  skillTemplate,
  slimSession,
  systemLocale,
  t,
  type TaskSnapshot,
  tn,
  type Tool,
  userRequests,
  VERSION,
} from '@orka/core';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type {
  AgentView,
  AppVersionView,
  ClaudeCodeStatus,
  ConfigView,
  ExternalAgentView,
  FromWebview,
  HunkView,
  ImageAttachment,
  McpServerView,
  ProviderView,
  SessionGroup,
  SettingsTab,
  SkillView,
} from './protocol';
import {
  type AgentChoice,
  type AppSettings,
  type CustomProviderDef,
  DESKTOP_SETTINGS,
  type Disposable,
  isCustomRef,
  MODEL_SETTING,
  type ProviderRef,
  readMcpServers,
  readSettings,
  SHELL_CHOICES,
  WEBVIEW_SETTINGS,
} from './settings';
import type { AppShell, PickItem, TerminalHandle } from './shell';

const isModelId = (value: unknown): value is string => typeof value === 'string' && /^[\w.:/@-]{1,160}$/.test(value);
const secretKey = (ref: string) => `orka.apiKey.${ref}`;
const ENV_KEYS: Partial<Record<ProviderKind, string[]>> = {
  claude: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 200_000;
const MCP_TRUST_STATE = 'orka.mcpTrust';
const MODEL_CACHE_STATE = 'orka.modelCache';
const CLAUDE_UPDATE_STATE = 'orka.claudeCodeUpdatedAt';
const HOOKS_TRUST_STATE = 'orka.hooksTrust';
/** How often model lists and Claude Code are refreshed in the background. */
const MODEL_REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_HUNKS = 40;
const MAX_HUNK_LINES = 80;
/** Tasks per folder in the desktop app's session list. */
const MAX_SESSION_TASKS = 30;
const APP_UPDATE_STATE = 'orka.appUpdate';
/** How often a running app looks again whether the daily update check is due. */
const APP_UPDATE_POLL_MS = 6 * 60 * 60 * 1000;

/** The last answer about Orka releases, and the version the user was already told about. */
interface AppUpdateState {
  /** The last attempt, answered or not: the next background check waits a day after it. */
  checkedAt?: number;
  etag?: string;
  latest?: string;
  url?: string;
  notified?: string;
  /** Why the last attempt got no answer (cleared by the next answer). */
  error?: string;
}
/** Global skills folder shared by the VS Code extension, the desktop app and the CLI. */
export const USER_SKILLS_DIR = path.join(homedir(), '.orka', 'skills');

/**
 * Owns the orchestrator for the current folder and connects it to the chat UI, settings, secret
 * storage, task history and diffs. The same controller runs in the VS Code extension and in the
 * desktop app; everything platform-specific goes through the AppShell. The main agent, the
 * supervisor and each sub-agent can run on any provider and model.
 */
export class AppController implements Disposable {
  private settings: AppSettings;
  private readonly permissions: PermissionManager;
  /** API keys by provider ref (built-in kind or "custom:<id>"). */
  private readonly apiKeys = new Map<string, string>();
  /** Models reported by a provider's own model list (built-in providers). */
  private readonly discoveredModels = new Map<string, string[]>();
  private readonly pendingApprovals = new Map<string, (response: ApprovalResponse) => void>();
  private readonly disposables: Disposable[] = [];
  /** Provider instances by configuration, shared by all agent roles. */
  private readonly providers = new Map<string, AIProvider>();
  private providersStale = false;
  private orchestrator?: Orchestrator;
  private host?: NodeHost;
  private store?: FileTaskStore;
  private task = { id: newTaskId(), createdAt: new Date().toISOString() };
  private session: SessionView = emptySession();
  private claudeCodeStatus: ClaudeCodeStatus = { state: 'unknown' };
  /** Built-in and user skills (all of them; disabled ones are filtered when a task starts). */
  private skills: Skill[] = [];
  private builtinSkillNames = new Set<string>();
  private skillErrors: string[] = [];
  /** MCP servers, kept running across tasks. */
  private readonly mcp = new McpManager(() => this.postConfig());
  /** Workspace snapshots around terminal commands and hand-offs (a private git dir). */
  private snapshots?: ShadowGit;
  /** An open hand-off to an external agent and the terminal it runs in. */
  private handoff?: { session: Handoff; terminal: TerminalHandle };
  /** The workspace .mcp.json as last read (for the settings view). */
  private workspaceMcpCache: { servers: Record<string, McpServerConfig>; hash: string } = { servers: {}, hash: '' };
  private appUpdateCheck?: Promise<void>;
  private appUpdateTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly shell: AppShell) {
    this.settings = readSettings(shell.settings);
    this.permissions = new PermissionManager(this.settings.mode, this.settings.overrides);
    this.applyLocale();
    shell.setMessageHandler((m) => void this.handleMessage(m).catch((e) => this.reportError(e)));
    this.disposables.push(
      shell.watch('skills', () => void this.reloadSkills()),
      shell.watch('mcpConfig', () => void this.workspaceMcp().then(() => this.postConfig())),
      shell.settings.onDidChange(() => void this.onSettingsChanged()),
      shell.onDidChangeFolder(() => this.recreateOrchestrator()),
    );
    const secrets = shell.secrets.onDidChange?.((key) => {
      const ref = this.keyedProviders().find((r) => secretKey(r) === key);
      if (ref) void this.loadApiKey(ref).then(() => this.postConfig());
    });
    if (secrets) this.disposables.push(secrets);
    this.updateStatus();
  }

  async initialize(): Promise<void> {
    await Promise.all([...this.keyedProviders().map((ref) => this.loadApiKey(ref)), this.reloadSkills(false)]);
    this.recreateOrchestrator();
    void (this.settings.claudeCode.enabled ? this.checkClaudeCode() : Promise.resolve()).then(() => this.scheduledUpdates());
    void this.workspaceMcp().then(() => this.postConfig());
    void this.checkAppUpdate();
    this.appUpdateTimer = setInterval(() => void this.checkAppUpdate(), APP_UPDATE_POLL_MS);
    this.appUpdateTimer.unref?.();
  }

  private updateSetting(key: string, value: unknown, options?: { preferGlobal?: boolean }): Promise<void> {
    return this.shell.settings.update(key, value, options);
  }

  /**
   * UI language: the setting, or on "auto" the surrounding app's display language when it is not
   * English (a VS Code language pack), otherwise the operating system's regional language.
   */
  private applyLocale(): void {
    const setting = this.settings.language;
    if (setting !== 'auto') {
      setLocale(setting);
      return;
    }
    const appLanguage = this.shell.appLanguage;
    setLocale(appLanguage && normalizeLocale(appLanguage) !== 'en' ? appLanguage : systemLocale());
  }

  // ---------------------------------------------------------------- chat UI messages

  async handleMessage(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.shell.post({ type: 'init', session: this.session, config: this.configView(), taskId: this.task.id });
        break;
      case 'send':
        await this.send(message.text, message.files, message.skills, message.images);
        break;
      case 'stop':
        this.stop();
        break;
      case 'rewind':
        await this.rewind(message.id);
        break;
      case 'newTask':
        await this.newTask(message.folder);
        break;
      case 'compact':
        await this.compact();
        break;
      case 'approve':
        this.resolveApproval(message.id, { approved: message.approved, feedback: message.feedback, alwaysAllow: message.always });
        break;
      case 'previewApproval':
        await this.shell.openApprovalPreview(message.id);
        break;
      case 'setMode':
        await this.updateSetting('permissionMode', message.mode);
        break;
      case 'setAgent':
        await this.setAgent(message.agent, message.provider, message.model);
        break;
      case 'customModel':
        await this.promptCustomModel(message.agent);
        break;
      case 'setSetting':
        await this.applyWebviewSetting(message.key, message.value);
        break;
      case 'setApiKey':
        await this.promptApiKey(message.provider);
        break;
      case 'clearApiKey':
        await this.clearApiKey(message.provider);
        break;
      case 'addProvider':
        await this.addProvider(message.preset);
        break;
      case 'removeProvider':
        await this.removeProvider(message.id);
        break;
      case 'loadModels':
        await this.loadModels(message.provider, true);
        break;
      case 'checkClaudeCode':
        await this.checkClaudeCode();
        break;
      case 'updateClaudeCode':
        await this.updateClaudeCode();
        break;
      case 'handoff':
        await this.handOff(message.agent, message.text);
        break;
      case 'checkForUpdates':
        await this.checkForUpdates();
        break;
      case 'checkAppUpdate':
        await this.checkAppUpdate(true);
        break;
      case 'openRelease': {
        const update = this.appVersionView().update;
        if (update) await this.shell.openExternal(update.url);
        break;
      }
      case 'pickClaudeExecutable':
        await this.pickClaudeExecutable();
        break;
      case 'resetClaudeExecutable':
        await this.updateSetting('claudeCode.path', '');
        await this.checkClaudeCode();
        break;
      case 'initMemory':
        await this.initMemory();
        break;
      case 'openSettings':
        await this.shell.openSettings('all');
        break;
      case 'listTasks':
        await this.postHistory();
        break;
      case 'listSessions':
        await this.postSessions();
        break;
      case 'openTask':
        await this.openTask(message.id, message.folder);
        break;
      case 'deleteTask':
        await this.deleteTask(message.id, message.folder);
        break;
      case 'searchFiles':
        await this.searchFiles(message.query);
        break;
      case 'openDiff':
        await this.shell.openChangeDiff(message.path);
        break;
      case 'openFile':
        await this.shell.openFile(message.path, { preview: true });
        break;
      case 'acceptChange':
        this.requireOrchestrator().changes.accept(message.path);
        break;
      case 'revertChange':
        await this.revert(message.path);
        break;
      case 'getHunks':
        await this.postHunks(message.path);
        break;
      case 'revertHunk':
        await this.revertHunk(message.path, message.index);
        break;
      case 'keepHunk':
        await this.keepHunk(message.path, message.index);
        break;
      case 'acceptAll':
        this.acceptAll();
        break;
      case 'revertAll':
        await this.revertAll();
        break;
      case 'toggleSkill':
        await this.toggleSkill(message.name, message.enabled);
        break;
      case 'openSkill':
        await this.openSkill(message.name);
        break;
      case 'customizeSkill':
        await this.customizeSkill(message.name);
        break;
      case 'newSkill':
        await this.newSkill();
        break;
      case 'openSkillsFolder':
        await this.openSkillsFolder();
        break;
      case 'reloadSkills':
        await this.reloadSkills();
        break;
      case 'selectFolder':
      case 'openFolder':
        await this.selectFolder(message.path);
        break;
      case 'toggleMcpServer':
        await this.setMcpServerEnabled(message.name, message.enabled);
        break;
      case 'importMcp':
        await this.importMcpFromClaude();
        break;
      case 'restartMcp':
        this.mcp.restart();
        break;
      case 'editMcpServers':
        await this.shell.openSettings('mcpServers');
        break;
      case 'dialogResult':
        // Answered inside the shell that asked.
        break;
    }
  }

  private async applyWebviewSetting(key: string, value: unknown): Promise<void> {
    if (key.startsWith('model:')) {
      // A provider's default model (Settings > Providers).
      const ref = key.slice('model:'.length);
      if (isModelId(value)) await this.setDefaultModel(ref, value);
      return;
    }
    if (DESKTOP_SETTINGS.has(key) && this.shell.kind !== 'desktop') return;
    if (WEBVIEW_SETTINGS[key]?.(value)) await this.updateSetting(key, value);
  }

  // ---------------------------------------------------------------- agent actions

  async send(text: string, files: string[] = [], skillNames: string[] = [], images: ImageAttachment[] = []): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const orchestrator = this.orchestrator;
    if (!orchestrator) {
      void this.shell.message('warning', this.noFolderText());
      return;
    }
    if (orchestrator.isRunning) {
      void this.shell.message('info', t('The agent is still working. Stop it first or wait until it finishes.'));
      return;
    }
    const main = this.mainProvider();
    if (!this.isReady(main)) {
      this.publishNotice(
        'error',
        t('No API key set for {provider}. Add one (kept in secure storage on this machine), or pick another provider for the main agent.', {
          provider: this.providerLabel(main),
        }),
        `setApiKey:${main}`,
      );
      return;
    }
    // Files an external agent changed meanwhile become reviewable changes, and the agent hears about them.
    if (this.handoff) await this.collectHandoff(false);
    // A new task picks up skills added or edited since the last one.
    if (!orchestrator.history.length) await this.reloadSkills(false);
    const invoked = [...new Set(skillNames)].map((name) => this.skills.find((s) => s.name === name)).filter((s): s is Skill => !!s);
    await this.confirmWorkspaceHooks();
    const attachments = await this.readAttachments(files);
    await orchestrator.run(trimmed, this.shell.editorContext(this.host!.workspaceRoot), attachments, { skills: invoked, images: validImages(images) });
  }

  private noFolderText(): string {
    return this.shell.canOpenFolder ? t('Orka: open a folder first.') : t('Orka: open a folder or workspace first.');
  }

  /** Start a task from a command (or programmatically with `text`). */
  async ask(text?: string): Promise<void> {
    const prompt =
      text ??
      (await this.shell.input({
        title: t('Orka: run a task'),
        placeHolder: t('e.g. Add a ready state to the lobby and limit it to 4 players'),
      }));
    if (!prompt?.trim()) return;
    this.shell.reveal();
    await this.send(prompt);
  }

  stop(): void {
    this.orchestrator?.stop();
  }

  /**
   * Go back to just before one of this task's messages: the conversation from there on is
   * removed, files the agents changed since are restored, and the message is put back in the box.
   */
  async rewind(id: string): Promise<void> {
    const orchestrator = this.orchestrator;
    if (!orchestrator) return;
    if (orchestrator.isRunning) {
      void this.shell.message('info', t('The agent is still working. Stop it first, then go back.'));
      return;
    }
    if (!orchestrator.rewindTargets.some((p) => p.id === id)) {
      void this.shell.message('info', t('Going back to this message is no longer possible: the task was compacted or reopened since.'));
      return;
    }
    const back = t('Go back');
    const choice = await this.shell.message(
      'warning',
      t('Go back to before this message? The conversation from here on is removed, and files the agents changed since return to how they were. The file changes stay reviewable in Changes.'),
      { modal: true },
      back,
    );
    if (choice !== back) return;
    const result = await orchestrator.rewind(id);
    if (!result) return;
    this.shell.post({ type: 'setInput', text: result.text });
    this.publishNotice(
      'info',
      result.restored.length
        ? t('Went back. Restored {n} file(s): {files}. Edit the message and send it again.', { n: result.restored.length, files: result.restored.slice(0, 8).join(', ') })
        : t('Went back. Edit the message and send it again.'),
    );
    await this.saveTask();
  }

  /**
   * Archive the current task in the history and start an empty one. With a folder (the desktop
   * app's session list), the new task is in that recent folder; without any folder, one is picked.
   */
  async newTask(folder?: string): Promise<void> {
    if (folder !== undefined || !this.orchestrator) {
      const target = folder === undefined ? undefined : this.recentFolder(folder);
      if (folder !== undefined && !target) return;
      // Another folder starts with a new task of its own.
      if (!target || !this.isCurrentFolder(target)) {
        await this.selectFolder(target);
        return;
      }
    }
    if (this.orchestrator?.isRunning) this.orchestrator.stop();
    await this.saveTask();
    this.task = { id: newTaskId(), createdAt: new Date().toISOString() };
    this.orchestrator?.reset();
    await this.postHistory();
  }

  async compact(): Promise<void> {
    const orchestrator = this.orchestrator;
    if (!orchestrator || orchestrator.isRunning) return;
    if (!this.isReady(this.mainProvider())) return;
    await orchestrator.compact();
    await this.saveTask();
  }

  acceptAll(): void {
    this.orchestrator?.changes.acceptAll();
  }

  async revertAll(): Promise<void> {
    const orchestrator = this.orchestrator;
    if (!orchestrator) return;
    const count = (await orchestrator.changes.list()).length;
    if (!count) return;
    const revertLabel = t('Revert All');
    const choice = await this.shell.message('warning', tn('Revert the {n} AI-changed file?', 'Revert all {n} AI-changed files?', count), { modal: true }, revertLabel);
    if (choice !== revertLabel) return;
    const reverted = await orchestrator.changes.revertAll();
    if (reverted.length) orchestrator.addNote(`The user reverted all of your file changes: ${reverted.join(', ')}.`);
  }

  private relPath(absPath: string): string {
    return path.relative(this.host!.workspaceRoot, absPath).split(path.sep).join('/');
  }

  private async revert(absPath: string): Promise<void> {
    const orchestrator = this.requireOrchestrator();
    await orchestrator.changes.revert(absPath);
    orchestrator.addNote(`The user reverted your changes to ${this.relPath(absPath)}.`);
  }

  /** Hunks of one changed file for the Changes panel. */
  private async postHunks(absPath: string): Promise<void> {
    const orchestrator = this.orchestrator;
    if (!orchestrator) return;
    const hunks = await orchestrator.changes.hunks(absPath).catch(() => []);
    const views: HunkView[] = hunks.slice(0, MAX_HUNKS).map((h) => ({
      header: hunkHeader(h),
      lines: h.lines.slice(0, MAX_HUNK_LINES).map((l) => ({ type: l.type, text: lineText(l.text) })),
      hidden: Math.max(0, h.lines.length - MAX_HUNK_LINES),
    }));
    this.shell.post({ type: 'hunks', path: absPath, hunks: views });
  }

  /** Keep one part of a change (the rest stays reviewable). */
  async keepHunk(absPath: string, index: number): Promise<void> {
    const orchestrator = this.requireOrchestrator();
    if (!Number.isInteger(index) || index < 0) return;
    if (!(await orchestrator.changes.acceptHunk(absPath, index))) {
      void this.shell.message('warning', t('That part of the change no longer exists; the file changed in the meantime.'));
    }
    await this.postHunks(absPath);
  }

  async openChangeDiff(absPath: string): Promise<void> {
    await this.shell.openChangeDiff(absPath);
  }

  async revertHunk(absPath: string, index: number): Promise<void> {
    const orchestrator = this.requireOrchestrator();
    if (!Number.isInteger(index) || index < 0) return;
    const hunk = (await orchestrator.changes.hunks(absPath))[index];
    if (!hunk || !(await orchestrator.changes.revertHunk(absPath, index))) {
      void this.shell.message('warning', t('That part of the change no longer exists; the file changed in the meantime.'));
    } else {
      orchestrator.addNote(`The user reverted part of your change to ${this.relPath(absPath)} (${hunkHeader(hunk)}). Re-read the file before editing it again.`);
    }
    await this.postHunks(absPath);
  }

  async initMemory(): Promise<void> {
    if (!this.host) return;
    const created = await initProjectMemory(this.host);
    void this.shell.message(
      'info',
      created.length ? t('Created {files}. The agent reads these at the start of each task.', { files: created.join(', ') }) : t('.project-ai already exists.'),
    );
    await this.shell.openFile(path.join(this.host.workspaceRoot, '.project-ai', 'decisions.md'));
    this.postConfig();
  }

  // ---------------------------------------------------------------- skills

  /** Skills offered to new tasks: all loaded skills minus the disabled ones. */
  private activeSkills(): Skill[] {
    if (!this.settings.skills.enabled) return [];
    const disabled = new Set(this.settings.skills.disabled);
    return this.skills.filter((s) => !disabled.has(s.name));
  }

  async reloadSkills(post = true): Promise<void> {
    const builtinDir = this.shell.builtinSkillsDir;
    const [builtin, all] = await Promise.all([
      loadSkills([{ dir: builtinDir, source: 'builtin' }]),
      loadSkills([
        { dir: builtinDir, source: 'builtin' },
        { dir: USER_SKILLS_DIR, source: 'user' },
      ]),
    ]);
    this.builtinSkillNames = new Set(builtin.skills.map((s) => s.name));
    this.skills = all.skills;
    this.skillErrors = all.errors;
    if (post) this.postConfig();
  }

  private async toggleSkill(name: string, enabled: boolean): Promise<void> {
    if (!SKILL_NAME.test(name)) return;
    const disabled = new Set(this.settings.skills.disabled);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await this.updateSetting('skills.disabled', [...disabled].sort());
  }

  private async openSkill(name: string): Promise<void> {
    const skill = this.skills.find((s) => s.name === name);
    if (skill) await this.shell.openFile(skill.path, { preview: true });
  }

  /** Copy a built-in skill into the user folder, where it overrides the built-in one, and open it. */
  private async customizeSkill(name: string): Promise<void> {
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) return;
    const target = path.join(USER_SKILLS_DIR, `${name}.md`);
    if (skill.source === 'builtin' && !existsSync(target)) {
      await fs.mkdir(USER_SKILLS_DIR, { recursive: true });
      await fs.copyFile(skill.path, target);
      await this.reloadSkills();
    }
    await this.shell.openFile(skill.source === 'user' ? skill.path : target);
  }

  async newSkill(): Promise<void> {
    const name = (
      await this.shell.input({
        title: t('New skill'),
        prompt: t('Name of the skill: lowercase letters, digits and dashes (e.g. "api-design").'),
        validate: (v) =>
          !SKILL_NAME.test(v.trim())
            ? t('Use lowercase letters, digits and dashes.')
            : this.skills.some((s) => s.name === v.trim() && s.source === 'user')
              ? t('A skill with this name already exists.')
              : undefined,
      })
    )?.trim();
    if (!name) return;
    await fs.mkdir(USER_SKILLS_DIR, { recursive: true });
    const file = path.join(USER_SKILLS_DIR, `${name}.md`);
    // "wx": create only if missing, in one step (an existing skill is opened as it is).
    await fs.writeFile(file, skillTemplate(name), { encoding: 'utf8', flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await this.shell.openFile(file);
    await this.reloadSkills();
  }

  async openSkillsFolder(): Promise<void> {
    await fs.mkdir(USER_SKILLS_DIR, { recursive: true });
    await this.shell.openExternal(USER_SKILLS_DIR);
  }

  // ---------------------------------------------------------------- MCP servers

  /** Servers from the workspace .mcp.json (the format Claude Code uses), if any. */
  private async workspaceMcp(): Promise<{ servers: Record<string, McpServerConfig>; hash: string }> {
    const root = this.host?.workspaceRoot;
    if (!root) return { servers: {}, hash: '' };
    try {
      const raw = await fs.readFile(path.join(root, '.mcp.json'), 'utf8');
      const servers = readMcpServers(JSON.parse(raw)?.mcpServers);
      this.workspaceMcpCache = { servers, hash: createHash('sha1').update(raw).digest('hex') };
    } catch {
      this.workspaceMcpCache = { servers: {}, hash: '' };
    }
    return this.workspaceMcpCache;
  }

  /**
   * The servers a task may use: the user's settings, plus the workspace .mcp.json once the user
   * allowed it (it starts programs on this machine, so a cloned repository must not do that silently).
   */
  private async mcpConfigs(askTrust: boolean): Promise<Record<string, McpServerConfig>> {
    const own = this.settings.mcp.servers;
    const workspace = await this.workspaceMcp();
    const names = Object.keys(workspace.servers).filter((n) => !(n in own));
    if (!names.length) return own;
    const trust = this.shell.workspaceState.get<{ hash: string; allowed: boolean }>(MCP_TRUST_STATE);
    let allowed = trust?.hash === workspace.hash ? trust.allowed : undefined;
    if (allowed === undefined && askTrust) {
      const allow = t('Allow');
      const choice = await this.shell.message(
        'warning',
        t('This folder defines MCP servers in .mcp.json: {names}. They start programs on your machine. Allow Orka to use them?', { names: names.join(', ') }),
        { modal: true },
        allow,
        t('Not now'),
      );
      allowed = choice === allow;
      await this.shell.workspaceState.update(MCP_TRUST_STATE, { hash: workspace.hash, allowed });
    }
    if (!allowed) return own;
    return { ...Object.fromEntries(names.map((n) => [n, workspace.servers[n]])), ...own };
  }

  /** Tools of all MCP servers for a new task (started on demand, kept running across tasks). */
  private async mcpTools(): Promise<Tool[]> {
    if (!this.settings.mcp.enabled) {
      this.mcp.sync({});
      return [];
    }
    this.mcp.sync(await this.mcpConfigs(true));
    return this.mcp.tools();
  }

  private async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    const servers = { ...this.settings.mcp.servers };
    if (servers[name]) {
      servers[name] = { ...servers[name], disabled: enabled ? undefined : true };
      await this.updateSetting('mcpServers', servers);
      return;
    }
    // A workspace server: switching it on means trusting the file, off means not.
    const workspace = await this.workspaceMcp();
    if (workspace.servers[name]) await this.shell.workspaceState.update(MCP_TRUST_STATE, { hash: workspace.hash, allowed: enabled });
    this.mcp.sync(await this.mcpConfigs(false));
  }

  private mcpView(): ConfigView['mcp'] {
    const status = new Map(this.mcp.status().map((s) => [s.name, s]));
    const trust = this.shell.workspaceState.get<{ hash: string; allowed: boolean }>(MCP_TRUST_STATE);
    const workspaceAllowed = trust?.hash === this.workspaceMcpCache.hash && trust.allowed;
    const view = (name: string, config: McpServerConfig, source: McpServerView['source']): McpServerView => {
      const s = status.get(name);
      return {
        name,
        source,
        transport: 'url' in config ? 'http' : 'stdio',
        target: 'url' in config ? config.url : [config.command, ...(config.args ?? [])].join(' '),
        enabled: source === 'workspace' ? workspaceAllowed : !config.disabled,
        state: s?.state ?? 'idle',
        tools: s?.tools ?? 0,
        error: s?.error,
      };
    };
    const own = this.settings.mcp.servers;
    return {
      enabled: this.settings.mcp.enabled,
      servers: [
        ...Object.entries(own).map(([n, c]) => view(n, c, 'settings')),
        ...Object.entries(this.workspaceMcpCache.servers)
          .filter(([n]) => !(n in own))
          .map(([n, c]) => view(n, c, 'workspace')),
      ],
    };
  }

  /** Copy the MCP servers configured for Claude Code (~/.claude.json) into Orka's settings. */
  async importMcpFromClaude(): Promise<void> {
    let data: any;
    try {
      data = JSON.parse(await fs.readFile(path.join(homedir(), '.claude.json'), 'utf8'));
    } catch {
      void this.shell.message('info', t('No Claude Code configuration (~/.claude.json) was found.'));
      return;
    }
    const root = this.host?.workspaceRoot?.replace(/\\/g, '/');
    const project = root ? Object.entries(data?.projects ?? {}).find(([p]) => p.toLowerCase() === root.toLowerCase())?.[1] : undefined;
    const found = readMcpServers({ ...(data?.mcpServers ?? {}), ...((project as any)?.mcpServers ?? {}) });
    const current = this.settings.mcp.servers;
    const added = Object.keys(found).filter((n) => !(n in current));
    if (!added.length) {
      void this.shell.message(
        'info',
        Object.keys(found).length ? t('All MCP servers from Claude Code are already in Orka.') : t('Claude Code has no MCP servers configured.'),
      );
      return;
    }
    await this.updateSetting('mcpServers', { ...current, ...Object.fromEntries(added.map((n) => [n, found[n]])) });
    void this.shell.message('info', t('Imported MCP servers from Claude Code: {names}. They start with the next task.', { names: added.join(', ') }));
  }

  // ---------------------------------------------------------------- workspace folder

  private async selectFolder(fsPath?: string): Promise<void> {
    if (fsPath && fsPath === this.host?.workspaceRoot) return;
    if (this.orchestrator?.isRunning) {
      void this.shell.message('info', t('Stop the agent before switching folders.'));
      this.postConfig();
      return;
    }
    // The shell reports a change through onDidChangeFolder, which recreates the orchestrator.
    if (!(await this.shell.selectFolder(fsPath))) this.postConfig();
  }

  /** Command palette: choose the folder of a multi-root workspace the agent works in. */
  async pickWorkspaceFolder(): Promise<void> {
    const folders = this.shell.folders();
    if (folders.length < 2 && !this.shell.canOpenFolder) {
      void this.shell.message('info', t('This workspace has a single folder; the agent works there.'));
      return;
    }
    const current = this.host?.workspaceRoot;
    const index = await this.shell.pick(
      folders.map((f) => ({ label: f.name, description: f.path === current ? t('current') : f.path })),
      { title: t('Folder the agent works in') },
    );
    if (index !== undefined) await this.selectFolder(folders[index].path);
  }

  private async readAttachments(files: string[]): Promise<Array<{ path: string; content: string }>> {
    const root = this.host?.workspaceRoot;
    if (!root) return [];
    const out: Array<{ path: string; content: string }> = [];
    for (const rel of [...new Set(files)].slice(0, MAX_ATTACHMENTS)) {
      const abs = path.resolve(root, rel);
      const inside = path.relative(root, abs);
      if (inside.startsWith('..') || path.isAbsolute(inside)) continue;
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) {
          this.publishNotice(
            'warning',
            stat.isFile()
              ? t('Skipped {file}: larger than 200 KB. The agent can still read it with its tools.', { file: rel })
              : t('Skipped {file}: not a file.', { file: rel }),
          );
          continue;
        }
        out.push({ path: inside.split(path.sep).join('/'), content: await this.host!.readFile(abs) });
      } catch {
        this.publishNotice('warning', t('Could not attach {file}.', { file: rel }));
      }
    }
    return out;
  }

  private async searchFiles(query: string): Promise<void> {
    const q = query.replace(/[\\[\]{}*?!]/g, '').trim();
    const root = this.host?.workspaceRoot;
    const files = q && root ? await this.shell.findFiles(root, q, 30).catch(() => []) : [];
    const rel = files.sort((a, b) => a.length - b.length).slice(0, 12);
    this.shell.post({ type: 'fileMatches', query, files: rel });
  }

  // ---------------------------------------------------------------- task history

  private taskTitle(): string {
    const first = this.session.items.find((i) => i.kind === 'user');
    const text = first && first.kind === 'user' ? first.text.replace(/\s+/g, ' ').trim() : t('Untitled task');
    return text.length > 90 ? `${text.slice(0, 87)}…` : text;
  }

  private async saveTask(): Promise<void> {
    const orchestrator = this.orchestrator;
    if (!orchestrator || !this.store) return;
    const state = orchestrator.snapshot();
    if (!state.messages.length) return;
    const snapshot: TaskSnapshot = {
      version: 1,
      id: this.task.id,
      title: this.taskTitle(),
      createdAt: this.task.createdAt,
      updatedAt: new Date().toISOString(),
      ...state,
      // The model history keeps full tool results; the replayed chat only needs a readable copy.
      view: slimSession(this.session),
    };
    try {
      await this.store.save(snapshot);
    } catch (error) {
      this.reportError(error);
    }
  }

  private async postHistory(): Promise<void> {
    const tasks = this.store ? await this.store.list() : [];
    this.shell.post({ type: 'history', tasks, currentId: this.orchestrator?.snapshot().messages.length ? this.task.id : undefined });
    await this.postSessions();
  }

  /** The desktop app's session list: the newest tasks of each recent folder. */
  private async postSessions(): Promise<void> {
    if (this.shell.kind !== 'desktop' || this.settings.desktop.layout !== 'ide') return;
    const groups: SessionGroup[] = await Promise.all(
      this.shell.folders().map(async (folder) => ({
        folder: folder.path,
        name: folder.name,
        tasks: (await new FileTaskStore(this.shell.storage(folder.path).tasks).list().catch(() => [])).slice(0, MAX_SESSION_TASKS),
      })),
    );
    this.shell.post({ type: 'sessions', groups, taskId: this.orchestrator ? this.task.id : undefined });
  }

  /** A folder named by the UI, if it is one of the recent folders (never any other path). */
  private recentFolder(folder: string): string | undefined {
    return this.shell.folders().find((f) => samePath(f.path, folder))?.path;
  }

  private isCurrentFolder(folder: string): boolean {
    const root = this.host?.workspaceRoot;
    return !!root && samePath(root, folder);
  }

  /** Open a task from the history; with a folder (desktop session list), first switch to that recent folder. */
  async openTask(id: string, folder?: string): Promise<void> {
    if (folder !== undefined) {
      const target = this.recentFolder(folder);
      if (!target) return;
      if (!this.isCurrentFolder(target)) {
        if (this.orchestrator?.isRunning) {
          void this.shell.message('info', t('Stop the agent before opening another task.'));
          return;
        }
        await this.selectFolder(target);
        if (!this.isCurrentFolder(target)) return;
      }
    }
    const orchestrator = this.orchestrator;
    if (!orchestrator || !this.store) return;
    if (orchestrator.isRunning) {
      void this.shell.message('info', t('Stop the agent before opening another task.'));
      return;
    }
    if (id === this.task.id) return;
    await this.saveTask();
    await this.reloadSkills(false);
    const snapshot = await this.store.load(id);
    if (!snapshot) {
      void this.shell.message('warning', t('That task could not be loaded.'));
      await this.postHistory();
      return;
    }
    orchestrator.restore(snapshot);
    this.task = { id: snapshot.id, createdAt: snapshot.createdAt };
    this.session = isSessionView(snapshot.view) ? { ...snapshot.view, running: false } : emptySession();
    this.session.usageByAgent = snapshot.usageByAgent;
    this.shell.post({ type: 'init', session: this.session, config: this.configView(), taskId: this.task.id });
    await this.postHistory();
  }

  async deleteTask(id: string, folder?: string): Promise<void> {
    const target = folder === undefined ? undefined : this.recentFolder(folder);
    if (folder !== undefined && !target) return;
    // A task of another recent folder (desktop session list) is deleted from that folder's history.
    const elsewhere = target !== undefined && !this.isCurrentFolder(target);
    const store = elsewhere ? new FileTaskStore(this.shell.storage(target).tasks) : this.store;
    if (!store) return;
    const deleteLabel = t('Delete');
    const choice = await this.shell.message('warning', t('Delete this task from the history? This cannot be undone.'), { modal: true }, deleteLabel);
    if (choice !== deleteLabel) return;
    await store.delete(id);
    if (!elsewhere && id === this.task.id) {
      this.task = { id: newTaskId(), createdAt: new Date().toISOString() };
      if (!this.orchestrator?.isRunning) this.orchestrator?.reset();
    }
    await this.postHistory();
  }

  // ---------------------------------------------------------------- approvals

  private requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    this.shell.setApprovalPreview(request.id, request.preview);
    if (!this.shell.visible) {
      this.shell.reveal();
      const show = t('Show');
      void this.shell.message('info', t('AI agent needs approval: {title}', { title: request.title }), {}, show).then((c) => c === show && this.shell.reveal());
    }
    return new Promise((resolve) => this.pendingApprovals.set(request.id, resolve));
  }

  private resolveApproval(id: string, response: ApprovalResponse): void {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return;
    this.pendingApprovals.delete(id);
    this.shell.clearApprovalPreview(id);
    resolve(response);
  }

  // ---------------------------------------------------------------- providers

  private customDef(ref: string): CustomProviderDef | undefined {
    return isCustomRef(ref) ? this.settings.customProviders.find((p) => `custom:${p.id}` === ref) : undefined;
  }

  /** Built-in kinds the user can pick: Claude Code only once they turned it on. */
  private builtInKinds(): ProviderKind[] {
    return PROVIDER_KINDS.filter((k) => k !== 'claude-code' || this.settings.claudeCode.enabled);
  }

  private allProviderRefs(): ProviderRef[] {
    return [...this.builtInKinds(), ...this.settings.customProviders.map((p) => `custom:${p.id}` as ProviderRef)];
  }

  /** Providers that may carry an API key. */
  private keyedProviders(): string[] {
    return [...PROVIDER_KINDS.filter((k) => PROVIDERS[k].auth === 'apiKey'), ...this.settings.customProviders.map((p) => `custom:${p.id}`)];
  }

  private providerLabel(ref: string): string {
    return this.customDef(ref)?.label ?? PROVIDERS[ref as ProviderKind]?.label ?? ref;
  }

  private defaultModel(ref: string): string {
    const custom = this.customDef(ref);
    if (custom) return custom.defaultModel;
    return this.settings.models[ref as ProviderKind] ?? '';
  }

  private isReady(ref: string): boolean {
    const custom = this.customDef(ref);
    if (custom) return !custom.requiresKey || !!this.apiKey(ref);
    const info = PROVIDERS[ref as ProviderKind];
    return !!info && (info.auth === 'local' || !!this.apiKey(ref));
  }

  private apiKey(ref: string): string | undefined {
    return this.apiKeys.get(ref) || (ENV_KEYS[ref as ProviderKind] ?? []).map((name) => process.env[name]).find(Boolean) || undefined;
  }

  private async loadApiKey(ref: string): Promise<void> {
    const value = await this.shell.secrets.get(secretKey(ref)).catch(() => undefined);
    if (value) this.apiKeys.set(ref, value);
    else this.apiKeys.delete(ref);
  }

  /**
   * The main agent's provider. One the user picked is always used. Until they pick one, a
   * provider that works right now is preferred over the default Claude API without a key: the
   * logged-in Claude Code CLI (when turned on), else the first provider that has a key.
   */
  private mainProvider(): ProviderRef {
    const s = this.settings;
    if (s.providerExplicit || this.isReady(s.provider)) return s.provider;
    if (s.claudeCode.enabled && this.claudeCodeStatus.state === 'ready') return 'claude-code';
    return this.allProviderRefs().find((ref) => ref !== 'claude-code' && this.isReady(ref)) ?? s.provider;
  }

  /**
   * Drop "no API key" notices that no longer apply (the key was added, or the main agent now runs
   * on another provider), so the chat never shows a key warning for a provider that is not in use.
   */
  private pruneKeyNotices(): void {
    const main = this.mainProvider();
    const before = this.session.items.length;
    this.session.items = this.session.items.filter((item) => {
      if (item.kind !== 'notice' || !item.action?.startsWith('setApiKey:')) return true;
      const ref = item.action.slice('setApiKey:'.length);
      return ref === main && !this.isReady(ref);
    });
    if (this.session.items.length !== before) this.shell.post({ type: 'init', session: this.session, config: this.configView(), taskId: this.task.id });
  }

  /** Provider/model an agent ("main", "supervisor" or a sub-agent) will actually run on. */
  private resolveAgent(name: string): { provider: ProviderRef; model: string } {
    const s = this.settings;
    const mainRef = this.mainProvider();
    const main = { provider: mainRef, model: this.defaultModel(mainRef) };
    if (name === 'main') return main;
    const choice: AgentChoice | undefined =
      name === 'supervisor' ? s.supervisor : name === 'fallback' ? s.fallback : name === 'light' ? s.light : s.subagents.agents[name];
    if (!choice || choice.provider === 'inherit') return main;
    return { provider: choice.provider, model: choice.model || this.defaultModel(choice.provider) };
  }

  private providerConfig(ref: string, model: string): ProviderConfig {
    const s = this.settings;
    const key = () => {
      const value = this.apiKey(ref);
      if (!value) throw new Error(t('No API key set for {provider}. Run "Orka: Set API Key".', { provider: this.providerLabel(ref) }));
      return value;
    };
    const custom = this.customDef(ref);
    if (custom) {
      return {
        kind: 'custom',
        id: custom.id,
        label: custom.label,
        baseURL: custom.baseUrl,
        apiKey: custom.requiresKey ? key() : this.apiKey(ref),
        model: model || undefined,
      };
    }
    switch (ref as ProviderKind) {
      case 'claude':
        return { kind: 'claude', apiKey: key(), model, effort: s.claude.effort, refusalFallback: s.claude.refusalFallback };
      case 'openai':
        return { kind: 'openai', apiKey: key(), model, baseURL: s.openai.baseUrl, reasoningEffort: s.openai.reasoningEffort };
      case 'gemini':
        return { kind: 'gemini', apiKey: key(), model, thinkingLevel: s.gemini.thinkingLevel };
      case 'claude-code':
        if (!s.claudeCode.enabled) throw new Error(t('Claude Code is turned off. Turn it on in Settings > Providers.'));
        return { kind: 'claude-code', model, effort: s.claudeCode.effort, executable: s.claudeCode.path };
      default:
        throw new Error(`Unknown provider "${ref}".`);
    }
  }

  private providerFor(name: string): AIProvider {
    const { provider: ref, model } = this.resolveAgent(name);
    if (!model && this.customDef(ref)) throw new Error(t('Pick a model for {provider} (Settings > Providers).', { provider: this.providerLabel(ref) }));
    const config = this.providerConfig(ref, model);
    const cacheKey = JSON.stringify(config);
    let provider = this.providers.get(cacheKey);
    if (!provider) {
      provider = createProvider(config);
      this.providers.set(cacheKey, provider);
    }
    return provider;
  }

  private disposeProviders(): void {
    for (const provider of this.providers.values()) provider.dispose?.();
    this.providers.clear();
    this.providersStale = false;
  }

  private async setDefaultModel(ref: string, model: string): Promise<void> {
    const custom = this.customDef(ref);
    if (custom) {
      await this.updateCustomProvider(custom.id, { defaultModel: model });
    } else if (PROVIDER_KINDS.includes(ref as ProviderKind)) {
      await this.updateSetting(MODEL_SETTING[ref as ProviderKind], model);
    }
  }

  private async updateCustomProvider(id: string, patch: Partial<CustomProviderDef>): Promise<void> {
    const list = this.settings.customProviders.map((p) => (p.id === id ? { ...p, ...patch } : p));
    await this.updateSetting('customProviders', list, { preferGlobal: true });
  }

  /** Add an OpenAI-compatible provider from a preset (OpenRouter, DeepSeek, Ollama, ...) or a custom URL. */
  async addProvider(presetId?: string): Promise<void> {
    let preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
    let label = preset?.label;
    let baseUrl = preset?.baseURL;
    let requiresKey = preset?.requiresKey ?? true;
    if (!preset) {
      label = (await this.shell.input({ title: t('Provider name'), placeHolder: t('e.g. My company gateway') }))?.trim();
      if (!label) return;
      baseUrl = (
        await this.shell.input({
          title: t('{provider}: base URL of its OpenAI-compatible API', { provider: label }),
          placeHolder: 'https://example.com/v1',
          validate: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : t('Enter an http(s) URL')),
        })
      )?.trim();
      if (!baseUrl) return;
      const choices = [t('Needs an API key'), t('No key (local server)')];
      const keyChoice = await this.shell.pick(
        choices.map((label) => ({ label })),
        { title: t('{provider}: authentication', { provider: label }) },
      );
      if (keyChoice === undefined) return;
      requiresKey = keyChoice === 0;
      preset = undefined;
    }
    const base = (presetId && preset ? preset.id : slug(label!)) || 'provider';
    let id = base;
    for (let n = 2; this.settings.customProviders.some((p) => p.id === id); n++) id = `${base}-${n}`;
    const def: CustomProviderDef = { id, label: label!, baseUrl: baseUrl!, requiresKey, models: [], defaultModel: '' };
    await this.updateSetting('customProviders', [...this.settings.customProviders, def], { preferGlobal: true });
    this.settings = readSettings(this.shell.settings);
    const ref = `custom:${id}`;
    if (requiresKey) await this.promptApiKey(ref);
    await this.loadModels(ref, false);
    this.postConfig();
  }

  async removeProvider(id: string): Promise<void> {
    const def = this.settings.customProviders.find((p) => p.id === id);
    if (!def) return;
    const removeLabel = t('Remove');
    const choice = await this.shell.message(
      'warning',
      t("Remove {provider}? Agents using it switch back to the main agent's provider.", { provider: def.label }),
      { modal: true },
      removeLabel,
    );
    if (choice !== removeLabel) return;
    await this.shell.secrets.delete(secretKey(`custom:${id}`));
    this.apiKeys.delete(`custom:${id}`);
    await this.updateSetting(
      'customProviders',
      this.settings.customProviders.filter((p) => p.id !== id),
      { preferGlobal: true },
    );
  }

  /** Fetch the provider's model list for the pickers. */
  async loadModels(ref: string, notify: boolean): Promise<void> {
    try {
      const models = await listModels(this.providerConfig(ref, this.defaultModel(ref)));
      const custom = this.customDef(ref);
      if (custom) {
        await this.updateCustomProvider(custom.id, { models, defaultModel: custom.defaultModel || models[0] || '' });
      } else {
        this.discoveredModels.set(ref, models);
        this.postConfig();
      }
      const cache = this.shell.globalState.get<Record<string, { at: number; models: string[] }>>(MODEL_CACHE_STATE, {});
      await this.shell.globalState.update(MODEL_CACHE_STATE, { ...cache, [ref]: { at: Date.now(), models } });
      if (notify) void this.shell.message('info', t('{provider}: {n} models available.', { provider: this.providerLabel(ref), n: models.length }));
    } catch (error) {
      if (notify) {
        void this.shell.message(
          'error',
          t('Could not load models from {provider}: {error}', { provider: this.providerLabel(ref), error: error instanceof Error ? error.message : String(error) }),
        );
      }
    }
  }

  private async setAgent(agent: string, provider: string, model: string): Promise<void> {
    const valid = provider === 'inherit' || this.allProviderRefs().includes(provider as ProviderRef);
    if (!valid || (model && !isModelId(model))) return;
    if (agent === 'main') {
      if (provider === 'inherit') return;
      if (provider !== this.settings.provider || !this.settings.providerExplicit) await this.updateSetting('provider', provider);
      if (model && model !== this.defaultModel(provider)) await this.setDefaultModel(provider, model);
      return;
    }
    if (agent === 'light') {
      await this.updateSetting('routing.provider', provider);
      await this.updateSetting('routing.model', provider === 'inherit' ? '' : model);
      return;
    }
    if (agent === 'fallback') {
      await this.updateSetting('fallback.provider', provider);
      await this.updateSetting('fallback.model', provider === 'inherit' ? '' : model);
      return;
    }
    if (agent === 'supervisor') {
      await this.updateSetting('supervisor.provider', provider);
      await this.updateSetting('supervisor.model', provider === 'inherit' ? '' : model);
      return;
    }
    if (!DEFAULT_SUBAGENTS.some((p) => p.name === agent)) return;
    const agents = { ...this.settings.subagents.agents, [agent]: { provider, model: provider === 'inherit' ? '' : model } };
    await this.updateSetting('subagents.agents', agents);
  }

  private async promptCustomModel(agent: string): Promise<void> {
    if (agent.startsWith('provider:')) {
      const ref = agent.slice('provider:'.length);
      if (!this.allProviderRefs().includes(ref as ProviderRef)) return;
      const value = await this.shell.input({
        title: t('Default model for {provider}', { provider: this.providerLabel(ref) }),
        value: this.defaultModel(ref),
        prompt: t('Any model id the provider accepts.'),
      });
      if (value?.trim() && isModelId(value.trim())) await this.setDefaultModel(ref, value.trim());
      return;
    }
    const current = this.resolveAgent(agent);
    const value = await this.shell.input({
      title:
        agent === 'main'
          ? t('Model for the main agent ({provider})', { provider: this.providerLabel(current.provider) })
          : t('Model for the {agent} agent ({provider})', { agent, provider: this.providerLabel(current.provider) }),
      value: current.model,
      prompt: t('Any model id the provider accepts.'),
    });
    if (!value?.trim()) return;
    const choice =
      agent === 'main'
        ? current.provider
        : agent === 'supervisor'
          ? this.settings.supervisor.provider
          : (this.settings.subagents.agents[agent]?.provider ?? 'inherit');
    await this.setAgent(agent, choice === 'inherit' ? current.provider : choice, value.trim());
  }

  async promptApiKey(ref?: string): Promise<void> {
    const keyed = this.keyedProviders();
    let target = ref && keyed.includes(ref) ? ref : undefined;
    if (!target) {
      const index = await this.shell.pick(
        keyed.map((r) => ({
          label: this.providerLabel(r),
          description: this.apiKeys.has(r) ? t('key stored') : this.apiKey(r) ? t('using environment variable') : t('no key'),
        })),
        { title: t('Set API key for which provider?') },
      );
      target = index === undefined ? undefined : keyed[index];
    }
    if (!target) return;
    const value = await this.shell.input({
      title: t('{provider} API key', { provider: this.providerLabel(target) }),
      prompt: t('Kept in secure storage on this machine. It is only sent to that provider.'),
      password: true,
    });
    if (!value?.trim()) return;
    await this.shell.secrets.store(secretKey(target), value.trim());
    await this.loadApiKey(target);
    this.postConfig();
    void this.shell.message('info', t('{provider} key saved.', { provider: this.providerLabel(target) }));
  }

  async clearApiKey(ref?: string): Promise<void> {
    let target = ref && this.apiKeys.has(ref) ? ref : undefined;
    if (!target) {
      const stored = this.keyedProviders().filter((r) => this.apiKeys.has(r));
      const index = await this.shell.pick(
        stored.map((r) => ({ label: this.providerLabel(r) })),
        { title: t('Remove the stored API key for...') },
      );
      target = index === undefined ? undefined : stored[index];
    }
    if (!target) return;
    const removeLabel = t('Remove');
    const confirm = await this.shell.message('warning', t('Remove the stored {provider} key?', { provider: this.providerLabel(target) }), { modal: true }, removeLabel);
    if (confirm !== removeLabel) return;
    await this.shell.secrets.delete(secretKey(target));
    this.apiKeys.delete(target);
    this.postConfig();
  }

  /** Detect the Claude Code CLI, its version and login state (shown in Settings > Providers). */
  async checkClaudeCode(): Promise<void> {
    this.claudeCodeStatus = { state: 'checking' };
    this.postConfig();
    const executable = resolveClaudeExecutable(this.settings.claudeCode.path);
    if (!executable) {
      this.claudeCodeStatus = { state: 'not_found', detail: t('Install it with: npm install -g @anthropic-ai/claude-code') };
      this.postConfig();
      return;
    }
    const run = (args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(executable, args, { timeout: 20_000, windowsHide: true }, (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout))),
      );
    try {
      const version = (await run(['--version'])).trim().split(/\s/)[0];
      let auth: { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string } = {};
      try {
        auth = JSON.parse(await run(['auth', 'status']));
      } catch {
        /* older CLIs have no auth status command */
      }
      const plan = auth.subscriptionType ? `claude.ai (${auth.subscriptionType})` : auth.authMethod;
      this.claudeCodeStatus =
        auth.loggedIn === false
          ? { state: 'logged_out', version, executable, detail: t('Run "claude" in a terminal and log in.') }
          : { state: 'ready', version, executable, account: [auth.email, plan].filter(Boolean).join(' · ') || undefined };
    } catch (error) {
      this.claudeCodeStatus = { state: 'error', executable, detail: error instanceof Error ? error.message : String(error) };
    }
    this.postConfig();
  }

  private async pickClaudeExecutable(): Promise<void> {
    const picked = await this.shell.pickFile({
      title: t('Select the claude executable'),
      filters: process.platform === 'win32' ? { Executable: ['exe', 'cmd'] } : undefined,
    });
    if (!picked) return;
    await this.updateSetting('claudeCode.path', picked);
    await this.checkClaudeCode();
  }

  /** Pick the main agent's provider, then its model version (grouped by family). */
  async selectProvider(): Promise<void> {
    const refs = this.allProviderRefs();
    const providerIndex = await this.shell.pick(
      refs.map((ref) => ({
        label: this.providerLabel(ref),
        description: `${this.modelLabel(ref, this.defaultModel(ref)) || t('no model yet')}${this.isReady(ref) ? '' : ` - ${t('needs API key')}`}`,
        picked: ref === this.mainProvider(),
      })),
      { title: t('Main agent provider') },
    );
    if (providerIndex === undefined) return;
    const ref = refs[providerIndex];
    const label = this.providerLabel(ref);
    const current = this.defaultModel(ref);
    const models = this.modelsFor(ref);
    if (current && !models.some((m) => m.id === current)) models.unshift(describeModel(ref, current, t('Current')));
    const items: Array<PickItem & { id?: string }> = [];
    let family = '';
    for (const m of models) {
      if (m.family !== family) {
        family = m.family;
        items.push({ label: t(family), separator: true });
      }
      items.push({ label: t(m.label), description: m.id === m.label ? undefined : m.id, detail: m.note ? t(m.note) : undefined, picked: m.id === current, id: m.id });
    }
    items.push({ label: '', separator: true }, { label: t('Other…'), description: t('type a model id'), id: '__other__' });
    const modelIndex = await this.shell.pick(items, { title: t('{provider} model', { provider: label }), matchOnDescription: true });
    const picked = modelIndex === undefined ? undefined : items[modelIndex]?.id;
    if (!picked) return;
    let model = picked;
    if (model === '__other__') {
      model = (await this.shell.input({ title: t('{provider} model id', { provider: label }), value: current }))?.trim() ?? '';
      if (!model) return;
    }
    await this.setAgent('main', ref, model);
    if (!this.isReady(ref)) await this.promptApiKey(ref);
  }

  async selectMode(): Promise<void> {
    const modes: Array<{ label: string; description: string; mode: PermissionMode }> = [
      { label: t('Ask'), description: t('Ask before every change, command and plan'), mode: 'ask' },
      { label: t('Balanced'), description: t('Edit files automatically; ask for risky actions'), mode: 'balanced' },
      { label: t('Autonomous'), description: t('Work independently; only destructive actions ask'), mode: 'autonomous' },
    ];
    const index = await this.shell.pick(
      modes.map((m) => ({ label: m.label, description: m.description, picked: m.mode === this.settings.mode })),
      { title: t('Permission mode') },
    );
    if (index !== undefined) await this.updateSetting('permissionMode', modes[index].mode);
  }

  showAgents(): void {
    this.shell.reveal();
    this.shell.post({ type: 'showAgents' });
  }

  showSettings(tab?: SettingsTab): void {
    this.shell.reveal();
    this.shell.post({ type: 'showSettings', tab });
  }

  showHistory(): void {
    this.shell.reveal();
    this.shell.post({ type: 'showHistory' });
    void this.postHistory();
  }

  /**
   * Models for the pickers, with version labels grouped by family: the built-in catalog first,
   * then whatever the provider itself reported (Load list). OpenRouter-style ids ("vendor/model")
   * are grouped by vendor.
   */
  private modelsFor(ref: string): ModelInfo[] {
    const custom = this.customDef(ref);
    const catalog = custom ? [] : (MODEL_CATALOG[ref] ?? []);
    const reported = (custom ? custom.models : (this.discoveredModels.get(ref) ?? [])).filter((id) => custom || isChatModelId(id));
    const out = [...catalog];
    for (const id of reported) {
      if (out.some((m) => m.id === id)) continue;
      const vendor = id.includes('/') ? id.slice(0, id.indexOf('/')) : '';
      // A model released after this build still lands in its family ("claude-opus-6" -> Claude Opus / Opus 6).
      const inferred = inferModel(vendor ? id.slice(vendor.length + 1) : id);
      out.push(
        inferred
          ? { ...inferred, id, family: vendor ? `${vendor} · ${inferred.family}` : inferred.family, note: 'new' }
          : { id, label: vendor ? id.slice(vendor.length + 1) : id, family: vendor || 'From the provider' },
      );
    }
    return out;
  }

  // ---------------------------------------------------------------- keeping up with the providers

  /**
   * Refresh the model lists of providers with a key once a day, so new model versions show up in
   * the pickers without an update of Orka. Results are cached across sessions.
   */
  private async refreshModelLists(force = false): Promise<void> {
    const cache = { ...this.shell.globalState.get<Record<string, { at: number; models: string[] }>>(MODEL_CACHE_STATE, {}) };
    for (const [ref, entry] of Object.entries(cache)) if (!this.customDef(ref)) this.discoveredModels.set(ref, entry.models);
    this.postConfig();
    const due = (ref: string) => force || !cache[ref] || Date.now() - cache[ref].at > MODEL_REFRESH_MS;
    const refs = this.keyedProviders().filter((ref) => this.isReady(ref) && due(ref));
    await Promise.all(
      refs.map(async (ref) => {
        try {
          const models = await listModels(this.providerConfig(ref, this.defaultModel(ref)));
          if (!models.length) return;
          cache[ref] = { at: Date.now(), models };
          const custom = this.customDef(ref);
          if (custom) await this.updateCustomProvider(custom.id, { models, defaultModel: custom.defaultModel || models[0] || '' });
          else this.discoveredModels.set(ref, models);
        } catch {
          /* offline or key problem: keep the cached list */
        }
      }),
    );
    await this.shell.globalState.update(MODEL_CACHE_STATE, cache);
    this.postConfig();
  }

  private claudeCodeUpdate?: Promise<boolean>;

  /**
   * Run "claude update" (a model can need a newer Claude Code than the one installed). Idle CLI
   * sessions are closed first so the executable can be replaced.
   */
  async updateClaudeCode(quiet = false): Promise<boolean> {
    if (this.claudeCodeUpdate) return this.claudeCodeUpdate;
    const executable = resolveClaudeExecutable(this.settings.claudeCode.path);
    if (!executable) {
      if (!quiet) this.publishNotice('error', t('Claude Code CLI not found.'));
      return false;
    }
    // Never swap the executable under a running agent; a quiet (scheduled) check simply waits.
    if (this.orchestrator?.isRunning) {
      if (quiet) return false;
      this.providersStale = true;
    } else this.disposeProviders();
    const before = this.claudeCodeStatus.version;
    if (!quiet) this.publishNotice('info', t('Updating Claude Code…'));
    this.claudeCodeUpdate = new Promise<{ ok: boolean; output: string }>((resolve) =>
      execFile(executable, ['update'], { timeout: 5 * 60_000, windowsHide: true }, (error, stdout, stderr) =>
        resolve({ ok: !error, output: `${stdout}\n${stderr}`.trim() }),
      ),
    ).then(async ({ ok, output }) => {
      await this.shell.globalState.update(CLAUDE_UPDATE_STATE, Date.now());
      await this.checkClaudeCode();
      const after = this.claudeCodeStatus.version;
      if (ok && after && after !== before) {
        const text = t('Claude Code was updated to {version}.', { version: after });
        if (quiet) this.shell.notify?.(`Orka: ${text}`);
        else this.publishNotice('info', `${text} ${t('Send your message again.')}`);
      } else if (ok) {
        if (!quiet) this.publishNotice('info', t('Claude Code is up to date ({version}).', { version: after ?? '?' }));
      } else if (!quiet) {
        const detail = output.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || '?';
        this.publishNotice('error', t('Claude Code could not be updated: {error}. Run "claude update" in a terminal.', { error: detail }));
      }
      return ok;
    });
    try {
      return await this.claudeCodeUpdate;
    } finally {
      this.claudeCodeUpdate = undefined;
      this.postConfig();
    }
  }

  /** Daily, in the background: fresh model lists from every provider, and the latest Claude Code. */
  private async scheduledUpdates(): Promise<void> {
    await this.refreshModelLists();
    const last = this.shell.globalState.get<number>(CLAUDE_UPDATE_STATE, 0);
    if (this.settings.claudeCode.enabled && this.settings.claudeCode.autoUpdate && Date.now() - last > MODEL_REFRESH_MS && this.claudeCodeStatus.state === 'ready') {
      await this.updateClaudeCode(true);
    }
  }

  private appVersionView(): AppVersionView {
    const saved = this.shell.globalState.get<AppUpdateState>(APP_UPDATE_STATE) ?? {};
    // Only a release page Orka builds itself for that version is ever opened.
    const url = saved.latest ? [releasePageUrl(`v${saved.latest}`), releasePageUrl(saved.latest)].find((u) => u && u === saved.url) : undefined;
    const update = saved.latest && url && isNewerVersion(saved.latest, VERSION) ? { version: saved.latest, url } : undefined;
    return {
      version: VERSION,
      checkUpdates: this.settings.checkUpdates,
      update,
      checkedAt: saved.checkedAt,
      error: typeof saved.error === 'string' ? saved.error.slice(0, 200) : undefined,
      checking: !!this.appUpdateCheck,
    };
  }

  /**
   * Is there a newer Orka release? Asked once a day in the background (setting updates.check, or
   * ORKA_NO_UPDATE_CHECK=1 to turn it off), or now from the settings. It only tells: the release
   * page opens in the browser if the user wants it; nothing is downloaded.
   */
  async checkAppUpdate(manual = false): Promise<void> {
    if (this.appUpdateCheck) return this.appUpdateCheck;
    const saved = this.shell.globalState.get<AppUpdateState>(APP_UPDATE_STATE) ?? {};
    if (!manual && (!this.settings.checkUpdates || process.env.ORKA_NO_UPDATE_CHECK || Date.now() - (saved.checkedAt ?? 0) < MODEL_REFRESH_MS)) return;
    this.appUpdateCheck = this.runAppUpdateCheck(saved, manual);
    this.postConfig();
    try {
      await this.appUpdateCheck;
    } catch (error) {
      if (manual) this.reportError(error);
    } finally {
      this.appUpdateCheck = undefined;
      this.postConfig();
    }
  }

  private async runAppUpdateCheck(saved: AppUpdateState, manual: boolean): Promise<void> {
    const result = await checkAppUpdate({ currentVersion: VERSION, etag: saved.etag });
    // At most one attempt a day, answered or not; not_modified: the saved answer still holds.
    const next: AppUpdateState = { ...saved, checkedAt: Date.now(), error: result.status === 'error' ? result.error || '?' : undefined };
    if (result.status === 'newer' || result.status === 'current') Object.assign(next, { etag: result.etag, latest: result.latest, url: result.url });
    await this.shell.globalState.update(APP_UPDATE_STATE, next);
    if (result.status === 'error') {
      if (manual) void this.shell.message('warning', t('Could not check for a new Orka version: {error}', { error: result.error ?? '?' }));
      return;
    }
    const update = this.appVersionView().update;
    if (!update) {
      if (manual) void this.shell.message('info', t('Orka is up to date ({version}).', { version: VERSION }));
      return;
    }
    // In the background, each new version is announced once.
    if (!manual && next.notified === update.version) return;
    await this.shell.globalState.update(APP_UPDATE_STATE, { ...next, notified: update.version });
    const download = t('Download');
    void this.shell
      .message('info', t('Orka {version} is available (you have {current}).', { version: update.version, current: VERSION }), {}, download)
      .then((choice) => (choice === download ? this.shell.openExternal(update.url) : undefined));
  }

  /** "Check for updates" (button or command): every provider's model list and Claude Code, now. */
  async checkForUpdates(): Promise<void> {
    const updateClaudeCode = this.settings.claudeCode.enabled && resolveClaudeExecutable(this.settings.claudeCode.path);
    await Promise.all([this.refreshModelLists(true), updateClaudeCode ? this.updateClaudeCode() : Promise.resolve(false)]);
    const models = this.keyedProviders().filter((r) => this.isReady(r)).length;
    void this.shell.message(
      'info',
      models
        ? t('Orka: model lists refreshed from {n} providers.', { n: models })
        : t('Orka: no provider with a key to refresh models from; built-in lists are used.'),
    );
  }

  /** A model that needs a newer Claude Code: update it right away when the user allows that. */
  private onAgentEvent(event: AgentEvent): void {
    const outdated =
      (event.type === 'notice' && event.action === 'claudeUpdate') ||
      (event.type === 'supervisor' && event.status === 'error' && /or newer is required/i.test(event.message ?? ''));
    if (outdated && this.settings.claudeCode.enabled && this.settings.claudeCode.autoUpdate && !this.claudeCodeUpdate) void this.updateClaudeCode();
    // Out of quota with no fallback: offer to go on in a free external agent.
    if (event.type === 'run_finished' && event.reason === 'error' && !this.handoff && USAGE_LIMIT.test(this.orchestrator?.lastError ?? '')) {
      const agent = EXTERNAL_AGENTS[0];
      this.publishNotice('info', t('The provider hit a usage limit. You can continue this task in {agent} for free.', { agent: agent.label }), `handoff:${agent.id}`);
    }
  }

  // ---------------------------------------------------------------- hand-off to external agents

  /** Whether each external agent is installed, looked up at most every 30 seconds. */
  private installed = new Map<string, { found: boolean; at: number }>();

  private isInstalled(id: string, fresh = false): boolean {
    const agent = externalAgent(id);
    if (!agent) return false;
    const cached = this.installed.get(id);
    if (!fresh && cached && Date.now() - cached.at < 30_000) return cached.found;
    const found = !!findExecutable(agent.command);
    this.installed.set(id, { found, at: Date.now() });
    return found;
  }

  private externalAgentsView(): ExternalAgentView[] {
    return EXTERNAL_AGENTS.map((a) => ({
      id: a.id,
      label: a.label,
      description: t(a.description),
      installed: this.isInstalled(a.id),
      active: this.handoff?.session.agent.id === a.id,
    }));
  }

  /**
   * Continue the task in an external agent that has no API (Freebuff): open it in a terminal in
   * this folder with a task summary on the clipboard, and snapshot the workspace, so the files it
   * changes show up under Changes (Keep / Revert) when the user comes back.
   */
  async handOff(agentId: string, text?: string): Promise<void> {
    const agent = externalAgent(agentId);
    const orchestrator = this.orchestrator;
    const root = this.host?.workspaceRoot;
    if (!agent) return;
    if (!orchestrator || !root) {
      void this.shell.message('warning', this.noFolderText());
      return;
    }
    if (orchestrator.isRunning) {
      void this.shell.message('info', t('The agent is still working. Stop it first or wait until it finishes.'));
      return;
    }
    if (this.handoff) {
      this.handoff.terminal.show();
      return;
    }
    if (!this.isInstalled(agent.id, true)) {
      const install = t('Install');
      const website = t('Website');
      const pick = await this.shell.message(
        'info',
        t('{agent} is not installed. Install it with: {command}', { agent: agent.label, command: agent.installCommand }),
        {},
        install,
        website,
      );
      if (pick === install) {
        this.shell.runInTerminal({ name: t('Install {agent}', { agent: agent.label }), cwd: root, command: agent.installCommand, onClose: () => this.postConfig() }).show();
      } else if (pick === website) {
        void this.shell.openExternal(agent.url);
      }
      return;
    }
    const session = new Handoff(agent, root, this.snapshots, orchestrator.changes);
    const tracked = await session.begin();
    const requests = [...userRequests(orchestrator.history), ...(text?.trim() ? [text.trim()] : [])];
    const brief = handoffBrief({ requests, plan: orchestrator.currentPlan, changedFiles: (await orchestrator.changes.list()).map((c) => c.relPath) });
    if (brief) await this.shell.writeClipboard(brief);
    const terminal = this.shell.runInTerminal({
      name: agent.label,
      cwd: root,
      command: agent.command,
      onClose: () => {
        if (this.handoff?.session === session) void this.collectHandoff(true);
      },
    });
    this.handoff = { session, terminal };
    terminal.show();
    const parts = [t('{agent} is open in the terminal.', { agent: agent.label })];
    if (brief) parts.push(t('The task summary is on the clipboard: paste it there.'));
    parts.push(
      tracked
        ? t('When you close that terminal or send Orka a message, the files {agent} changed show up under Changes.', { agent: agent.label })
        : t("Orka can't track what {agent} changes: {reason}.", { agent: agent.label, reason: session.untrackedReason ?? t('snapshots are off') }),
    );
    this.publishNotice('info', parts.join(' '));
    this.postConfig();
  }

  /** Pick up what the external agent changed; `ended` when its terminal was closed. */
  private async collectHandoff(ended: boolean): Promise<void> {
    const handoff = this.handoff;
    if (!handoff) return;
    if (ended) this.handoff = undefined;
    const label = handoff.session.agent.label;
    const changed = await handoff.session.collect(!ended).catch(() => []);
    if (changed.length) {
      const files = changed.map((c) => c.path);
      this.orchestrator?.addNote(
        `The user worked on this task in ${label} (another coding agent) and it changed: ${files.join(', ')}. Read these files before building on them.`,
      );
      const shown = files.slice(0, 6).join(', ') + (files.length > 6 ? ', …' : '');
      this.publishNotice('info', t('{agent} changed {n} file(s): {files}. Review them under Changes (Keep / Revert).', { agent: label, n: files.length, files: shown }));
    } else if (ended) {
      this.publishNotice('info', t('{agent} closed without changing any files.', { agent: label }));
    }
    if (ended) this.postConfig();
  }

  /** "Opus 5.5" for a known id, the id itself otherwise. */
  private modelLabel(ref: string, id: string): string {
    const label = this.modelsFor(ref).find((m) => m.id === id)?.label;
    return label ? t(label) : id;
  }

  // ---------------------------------------------------------------- state plumbing

  /** The agents' settings; hooks from the folder's own settings only once the user allowed them. */
  private orchestratorSettings(): OrchestratorSettings {
    const s = this.settings;
    if (!s.hooksFromWorkspace || !hasHooks(s.orchestrator.hooks)) return s.orchestrator;
    const trust = this.shell.workspaceState.get<{ hash: string; allowed: boolean }>(HOOKS_TRUST_STATE);
    return trust?.hash === hooksHash(s.orchestrator.hooks) && trust.allowed ? s.orchestrator : { ...s.orchestrator, hooks: NO_HOOKS };
  }

  /**
   * Hooks defined in the open folder's settings run commands without asking, and a cloned
   * repository controls those settings: ask once for each version of them.
   */
  private async confirmWorkspaceHooks(): Promise<void> {
    const hooks = this.settings.orchestrator.hooks;
    if (!this.settings.hooksFromWorkspace || !hasHooks(hooks)) return;
    const hash = hooksHash(hooks);
    if (this.shell.workspaceState.get<{ hash: string }>(HOOKS_TRUST_STATE)?.hash === hash) return;
    const commands = [...(hooks?.afterEdit ?? []), ...(hooks?.beforeFinish ?? [])].map((h) => h.command);
    const allow = t('Allow');
    const choice = await this.shell.message(
      'warning',
      t('This folder\'s settings define hooks that run commands on your machine while the agent works: {commands}. Allow them?', { commands: commands.join(' · ') }),
      { modal: true },
      allow,
      t('Not now'),
    );
    await this.shell.workspaceState.update(HOOKS_TRUST_STATE, { hash, allowed: choice === allow });
  }

  private recreateOrchestrator(): void {
    void this.saveTask();
    // A hand-off belongs to the workspace and change list being replaced.
    this.handoff = undefined;
    this.orchestrator?.dispose();
    this.host?.stopAllProcesses();
    for (const resolve of this.pendingApprovals.values()) resolve({ approved: false });
    this.pendingApprovals.clear();
    const folder = this.shell.currentFolder();
    if (!folder) {
      this.orchestrator = undefined;
      this.host = undefined;
      this.store = undefined;
      this.snapshots = undefined;
      this.shell.attach(undefined, this.settings);
      this.session = emptySession();
      this.shell.post({ type: 'init', session: this.session, config: this.configView(), taskId: this.task.id });
      this.updateStatus();
      return;
    }
    this.host = this.shell.createHost({
      root: folder.path,
      shell: this.settings.shell,
      browserPath: this.settings.browserPath,
      approve: (r) => this.requestApproval(r),
    });
    const storage = this.shell.storage(folder.path);
    this.snapshots = new ShadowGit(folder.path, storage.snapshots);
    this.store = new FileTaskStore(storage.tasks);
    this.task = { id: newTaskId(), createdAt: new Date().toISOString() };
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- read by a getter below, so the setting applies at once
    const controller = this;
    const orchestrator = new Orchestrator({
      host: this.host,
      getProvider: () => this.providerFor('main'),
      getExtraTools: () => this.mcpTools(),
      getLightProvider: () => (this.settings.light.provider === 'inherit' ? undefined : this.providerFor('light')),
      get commandSnapshots() {
        return controller.settings.trackCommandChanges ? controller.snapshots : undefined;
      },
      getFallbackProvider: () => (this.settings.fallback.provider === 'inherit' ? undefined : this.providerFor('fallback')),
      permissions: this.permissions,
      getSettings: () => this.orchestratorSettings(),
      subagents: {
        getProfiles: () => (this.settings.subagents.enabled ? DEFAULT_SUBAGENTS : []),
        getProvider: (name) => this.providerFor(name),
      },
      supervisor: {
        getProvider: () => this.providerFor('supervisor'),
        getSettings: () => this.settings.supervisor,
      },
      skills: () => this.activeSkills(),
    });
    orchestrator.on((event) => {
      if (event.type === 'reset') this.session = emptySession();
      applyEvent(this.session, event);
      this.shell.post({ type: 'event', event });
      this.onAgentEvent(event);
      if (event.type === 'run_started' || event.type === 'run_finished') this.updateStatus();
      if (event.type === 'run_finished') {
        // Any approval still open belongs to a finished run.
        for (const [id, resolve] of this.pendingApprovals) {
          resolve({ approved: false });
          this.shell.clearApprovalPreview(id);
        }
        this.pendingApprovals.clear();
        if (this.providersStale) this.disposeProviders();
        void this.saveTask().then(() => this.postHistory());
      }
    });
    this.orchestrator = orchestrator;
    this.shell.attach(orchestrator, this.settings);
    this.session = emptySession();
    this.shell.post({ type: 'init', session: this.session, config: this.configView(), taskId: this.task.id });
    this.updateStatus();
    void this.workspaceMcp().then(() => this.postConfig());
  }

  private async onSettingsChanged(): Promise<void> {
    const previousShell = this.settings.shell;
    const claudeCodeWasEnabled = this.settings.claudeCode.enabled;
    this.settings = readSettings(this.shell.settings);
    if (this.settings.claudeCode.enabled && !claudeCodeWasEnabled) void this.checkClaudeCode();
    this.applyLocale();
    this.shell.settingsChanged?.(this.settings);
    await Promise.all(this.keyedProviders().filter((r) => !this.apiKeys.has(r)).map((r) => this.loadApiKey(r)));
    this.permissions.setMode(this.settings.mode);
    this.permissions.setOverrides(this.settings.overrides);
    // Provider settings may have changed: rebuild providers once nothing is using them.
    if (this.orchestrator?.isRunning) this.providersStale = true;
    else this.disposeProviders();
    if (previousShell !== this.settings.shell && !this.orchestrator?.isRunning) this.recreateOrchestrator();
    this.updateStatus();
    this.postConfig();
  }

  private publishNotice(level: 'info' | 'warning' | 'error', message: string, action?: string): void {
    const event = { type: 'notice' as const, level, message, action };
    applyEvent(this.session, event);
    this.shell.post({ type: 'event', event });
  }

  private reportError(error: unknown): void {
    void this.shell.message('error', `Orka: ${error instanceof Error ? error.message : String(error)}`);
  }

  private configView(): ConfigView {
    const s = this.settings;
    const agentView = (name: string, choice: AgentChoice, extra: Partial<AgentView> = {}): AgentView => ({
      name,
      provider: choice.provider,
      model: choice.model,
      effective: this.resolveAgent(name),
      ...extra,
    });
    const keyInfo = (ref: string): ProviderView['key'] => {
      const stored = this.apiKeys.get(ref);
      if (stored) return { source: 'stored', hint: stored.length > 8 ? `${stored.slice(0, 6)}••••${stored.slice(-4)}` : '••••' };
      const env = (ENV_KEYS[ref as ProviderKind] ?? []).find((name) => process.env[name]);
      return env ? { source: 'env', hint: env } : undefined;
    };
    const root = this.host?.workspaceRoot;
    const folders = this.shell.folders();
    const disabledSkills = new Set(s.skills.disabled);
    const skills: SkillView[] = this.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      enabled: !disabledSkills.has(skill.name),
      overridesBuiltin: skill.source === 'user' && this.builtinSkillNames.has(skill.name),
    }));
    const builtIns: ProviderView[] = this.builtInKinds().map((k) => ({
      kind: k,
      label: PROVIDERS[k].label,
      local: PROVIDERS[k].auth === 'local',
      ready: this.isReady(k),
      models: this.modelsFor(k),
      model: s.models[k],
      key: PROVIDERS[k].auth === 'apiKey' ? keyInfo(k) : undefined,
    }));
    const customs: ProviderView[] = s.customProviders.map((p) => {
      const ref = `custom:${p.id}`;
      return {
        kind: ref,
        label: p.label,
        local: !p.requiresKey,
        ready: this.isReady(ref),
        models: this.modelsFor(ref),
        model: p.defaultModel,
        key: keyInfo(ref),
        custom: { id: p.id, baseUrl: p.baseUrl, requiresKey: p.requiresKey },
      };
    });
    return {
      locale: getLocale(),
      mode: s.mode,
      workspaceOpen: !!this.orchestrator,
      folders: folders.length > 1 || (this.shell.canOpenFolder && folders.length) ? folders : undefined,
      folder: root,
      canOpenFolder: this.shell.canOpenFolder,
      skillsEnabled: s.skills.enabled,
      skills,
      skillErrors: this.skillErrors,
      skillsFolder: USER_SKILLS_DIR,
      mcp: this.mcpView(),
      externalAgents: this.externalAgentsView(),
      pricing: s.pricing,
      providers: [...builtIns, ...customs],
      main: agentView('main', { provider: this.mainProvider(), model: this.defaultModel(this.mainProvider()) }),
      supervisor: agentView('supervisor', s.supervisor),
      fallback: agentView('fallback', s.fallback),
      light: agentView('light', s.light),
      subagentsEnabled: s.subagents.enabled,
      subagents: DEFAULT_SUBAGENTS.map((p) =>
        agentView(p.name, s.subagents.agents[p.name] ?? { provider: 'inherit', model: '' }, { description: p.description, access: p.access }),
      ),
      settings: {
        permissionMode: s.mode,
        permissions: {
          fileEdit: s.overrides.fileEdit ?? 'mode',
          terminal: s.overrides.terminal ?? 'mode',
          git: s.overrides.git ?? 'mode',
          delete: s.overrides.delete ?? 'mode',
          network: s.overrides.network ?? 'mode',
        },
        autoVerify: s.orchestrator.autoVerify,
        trackCommandChanges: { enabled: s.trackCommandChanges, unavailable: this.snapshots?.disabledReason },
        inlineReview: this.shell.kind === 'vscode' ? s.inlineReview : undefined,
        maxIterations: s.orchestrator.maxIterations,
        tokenBudget: s.orchestrator.tokenBudget ?? 0,
        language: s.language,
        commandTimeoutSeconds: Math.round(s.orchestrator.commandTimeoutMs / 1000),
        shell: s.shell ?? '',
        shellChoices: SHELL_CHOICES,
        customInstructions: s.orchestrator.customInstructions ?? '',
        compaction: s.orchestrator.compaction,
        subagentsMaxParallel: s.orchestrator.maxParallelSubagents ?? 3,
        parallelWorkers: s.orchestrator.parallelWorkers !== false,
        claude: { effort: s.claude.effort, refusalFallback: s.claude.refusalFallback },
        openai: { baseUrl: s.openai.baseUrl, reasoningEffort: s.openai.reasoningEffort ?? '' },
        gemini: { thinkingLevel: s.gemini.thinkingLevel ?? '' },
        claudeCode: {
          enabled: s.claudeCode.enabled,
          effort: s.claudeCode.effort ?? '',
          path: s.claudeCode.path ?? '',
          status: this.claudeCodeStatus,
          autoUpdate: s.claudeCode.autoUpdate,
          updating: !!this.claudeCodeUpdate,
          updatedAt: this.shell.globalState.get<number>(CLAUDE_UPDATE_STATE),
        },
        modelsRefreshedAt:
          Math.max(0, ...Object.values(this.shell.globalState.get<Record<string, { at: number }>>(MODEL_CACHE_STATE, {})).map((e) => e.at)) || undefined,
        supervisor: {
          enabled: s.supervisor.enabled,
          frequency: s.supervisor.frequency,
          maxInterventions: s.supervisor.maxInterventions,
          mode: s.supervisor.mode ?? 'parallel',
        },
        projectMemory: !root ? 'no_workspace' : existsSync(path.join(root, '.project-ai')) ? 'present' : 'missing',
        learnLessons: s.orchestrator.learnLessons !== false,
        presets: PROVIDER_PRESETS.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseURL, requiresKey: p.requiresKey })),
      },
      app: this.appVersionView(),
      ui: this.shell.kind === 'desktop' ? { layout: s.desktop.layout, theme: s.desktop.theme } : undefined,
    };
  }

  private postConfig(): void {
    this.pruneKeyNotices();
    this.updateStatus();
    this.shell.post({ type: 'config', config: this.configView() });
  }

  private updateStatus(): void {
    if (!this.shell.status) return;
    const running = !!this.orchestrator?.isRunning;
    const main = this.resolveAgent('main');
    const s = this.settings;
    const modeLabel = { ask: t('Ask'), balanced: t('Balanced'), autonomous: t('Autonomous') }[s.mode];
    const line = (name: string) => {
      const r = this.resolveAgent(name);
      return `${this.providerLabel(r.provider)} / ${r.model ? this.modelLabel(r.provider, r.model) : t('(no model)')}`;
    };
    const subs = s.subagents.enabled ? DEFAULT_SUBAGENTS.map((p) => `  ${p.name}: ${line(p.name)}`).join('\n') : `  ${t('(disabled)')}`;
    const sup = s.supervisor.enabled ? `Supervisor: ${line('supervisor')}` : `Supervisor: ${t('off')}`;
    this.shell.status({
      running,
      text: `${this.providerLabel(main.provider)} · ${modeLabel}`,
      tooltip: [
        'Orka',
        `${t('Main agent')}: ${line('main')}`,
        sup,
        `Sub-agents:\n${subs}`,
        `${t('Permission mode')}: ${modeLabel}`,
        '',
        t('Click to configure agents.'),
      ].join('\n'),
    });
  }

  private requireOrchestrator(): Orchestrator {
    if (!this.orchestrator) throw new Error('No workspace folder is open.');
    return this.orchestrator;
  }

  async dispose(): Promise<void> {
    clearInterval(this.appUpdateTimer);
    await this.saveTask();
    this.orchestrator?.dispose();
    for (const resolve of this.pendingApprovals.values()) resolve({ approved: false });
    this.disposeProviders();
    this.mcp.dispose();
    this.host?.stopAllProcesses();
    for (const d of this.disposables) d.dispose();
  }
}

/** Two paths name the same folder (Windows paths ignore case). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/** Errors that mean the provider's quota or session limit is used up. */
const USAGE_LIMIT = /usage limit|rate.?limit|session limit|quota|\b429\b|too many requests/i;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 5;
/** Base64 length of about 5 MB of image data (the Claude API's per-image limit). */
const MAX_IMAGE_BASE64 = 6_900_000;

/** Images from the chat UI, checked before they reach a model: type, size, count, and a well-formed thumbnail. */
export function validImages(images: unknown): ImageAttachment[] {
  if (!Array.isArray(images)) return [];
  const out: ImageAttachment[] = [];
  for (const raw of images.slice(0, MAX_IMAGES)) {
    const i = raw as Partial<ImageAttachment>;
    if (!i || typeof i.data !== 'string' || !IMAGE_TYPES.has(String(i.mediaType))) continue;
    if (i.data.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(i.data)) continue;
    const thumb = typeof i.thumb === 'string' && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(i.thumb) && i.thumb.length < 80_000 ? i.thumb : undefined;
    out.push({ name: String(i.name ?? 'image').slice(0, 80), mediaType: i.mediaType as ImageAttachment['mediaType'], data: i.data, thumb });
  }
  return out;
}

function isSessionView(value: unknown): value is SessionView {
  return !!value && typeof value === 'object' && Array.isArray((value as SessionView).items);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function hooksHash(hooks: HooksConfig | undefined): string {
  return createHash('sha1').update(JSON.stringify(hooks ?? {})).digest('hex');
}
