/**
 * Messages between the app (VS Code extension or desktop app) and the chat UI. Type-only imports
 * keep the UI bundle free of Node code.
 */
import type { AgentEvent, Locale, ModelInfo, PermissionMode, PriceTable, SessionView, TaskSummary } from '@orka/core';

export interface ProviderView {
  /** Built-in kind ("claude", "openai", "gemini", "claude-code") or "custom:<id>". */
  kind: string;
  label: string;
  local: boolean;
  /** Ready to use: key present when one is needed. */
  ready: boolean;
  /** Known models with version labels, grouped by family in the pickers. */
  models: ModelInfo[];
  /** The provider's configured default model. */
  model: string;
  /** Where the key comes from: "stored" (secret storage, with a masked hint), "env" (variable name), or none. */
  key?: { source: 'stored' | 'env'; hint: string };
  /** Set for user-added OpenAI-compatible endpoints. */
  custom?: { id: string; baseUrl: string; requiresKey: boolean };
}

export interface AgentView {
  /** "main", "supervisor" or a sub-agent name. */
  name: string;
  description?: string;
  access?: 'readonly' | 'full';
  /** Provider ref or "inherit". */
  provider: string;
  /** Configured model ('' = provider default). */
  model: string;
  /** What will actually run, after inheritance and defaults. */
  effective: { provider: string; model: string };
}

export interface ClaudeCodeStatus {
  state: 'unknown' | 'checking' | 'ready' | 'not_found' | 'logged_out' | 'error';
  version?: string;
  account?: string;
  executable?: string;
  detail?: string;
}

export interface PresetView {
  id: string;
  label: string;
  baseUrl: string;
  requiresKey: boolean;
}

export interface SkillView {
  name: string;
  description: string;
  source: 'builtin' | 'user';
  enabled: boolean;
  /** A user skill with the same name as a built-in one replaces it. */
  overridesBuiltin?: boolean;
}

export interface SettingsView {
  permissionMode: PermissionMode;
  permissions: { fileEdit: string; terminal: string; git: string; delete: string; network: string };
  autoVerify: boolean;
  /** Command snapshots: on/off, and why they are unavailable if they are. */
  trackCommandChanges: { enabled: boolean; unavailable?: string };
  /** Keep / Revert above changes in the editor (VS Code only; undefined elsewhere). */
  inlineReview?: boolean;
  maxIterations: number;
  tokenBudget: number;
  commandTimeoutSeconds: number;
  shell: string;
  shellChoices: string[];
  customInstructions: string;
  compaction: { auto: boolean; thresholdTokens: number };
  subagentsMaxParallel: number;
  parallelWorkers: boolean;
  claude: { effort: string; refusalFallback: boolean };
  openai: { baseUrl: string; reasoningEffort: string };
  gemini: { thinkingLevel: string };
  claudeCode: { enabled: boolean; effort: string; path: string; status: ClaudeCodeStatus; autoUpdate: boolean; updating: boolean; updatedAt?: number };
  /** When the provider model lists were last refreshed (ms since epoch). */
  modelsRefreshedAt?: number;
  supervisor: { enabled: boolean; frequency: 'checkpoints' | 'every_turn' | 'on_changes' | 'final_only'; maxInterventions: number; mode: 'parallel' | 'blocking' };
  projectMemory: 'present' | 'missing' | 'no_workspace';
  learnLessons: boolean;
  presets: PresetView[];
  /** The language setting ("auto" follows the machine). */
  language: 'auto' | 'en' | 'tr';
}

export interface ConfigView {
  /** UI language in effect. */
  locale: Locale;
  mode: PermissionMode;
  workspaceOpen: boolean;
  /** Folders of a multi-root workspace (only when there is more than one) and the one the agent works in. */
  folders?: Array<{ name: string; path: string }>;
  folder?: string;
  /** Desktop: the user picks the folder in the app ("Open folder…"); VS Code opens folders itself. */
  canOpenFolder?: boolean;
  providers: ProviderView[];
  main: AgentView;
  supervisor: AgentView;
  /** Where the main agent continues when its provider hits a limit (provider "inherit" = off). */
  fallback: AgentView;
  /** The lighter model for short questions (provider "inherit" = off). */
  light: AgentView;
  subagentsEnabled: boolean;
  subagents: AgentView[];
  skillsEnabled: boolean;
  skills: SkillView[];
  skillErrors: string[];
  skillsFolder: string;
  mcp: { enabled: boolean; servers: McpServerView[] };
  /** Agents that run on their own in a terminal (Freebuff); Orka hands tasks over to them. */
  externalAgents: ExternalAgentView[];
  pricing: PriceTable;
  settings: SettingsView;
  /** Orka's own version and the newest release, if an update check found one. */
  app: AppVersionView;
  /** Desktop only: the window's layout and color theme. */
  ui?: { layout: 'ide' | 'classic'; theme: 'system' | 'light' | 'dark' };
}

export interface AppVersionView {
  version: string;
  /** Check for new Orka versions once a day (setting updates.check). */
  checkUpdates: boolean;
  /** A newer release than the one running. */
  update?: { version: string; url: string };
  /** When the last check ran (ms since epoch). */
  checkedAt?: number;
  /** The last check got no answer: why. */
  error?: string;
  checking?: boolean;
}

/** One project folder in the desktop app's session list, with its newest tasks. */
export interface SessionGroup {
  folder: string;
  name: string;
  tasks: TaskSummary[];
}

/** How the user arranged the session list: their own groups, which task is in which, hidden tasks. */
export interface SessionOrganizerView {
  groups: Array<{ id: string; name: string }>;
  /** Task id -> group id. */
  assigned: Record<string, string>;
  /** Task ids kept out of the list. */
  hidden: string[];
}

export type SessionOrganizeOp =
  /** Asks for a name; with taskId, that task moves into the new group. */
  | { op: 'createGroup'; taskId?: string }
  | { op: 'renameGroup'; groupId: string }
  /** The group's sessions go back under their folders. */
  | { op: 'deleteGroup'; groupId: string }
  /** Without groupId, the task leaves its group. */
  | { op: 'moveToGroup'; taskId: string; groupId?: string }
  | { op: 'hide'; taskId: string; hidden: boolean };

export interface ExternalAgentView {
  id: string;
  label: string;
  description: string;
  installed: boolean;
  /** A hand-off to it is open (its terminal is still running). */
  active: boolean;
}

export interface McpServerView {
  name: string;
  /** "settings": Orka's own list; "workspace": the folder's .mcp.json. */
  source: 'settings' | 'workspace';
  transport: 'stdio' | 'http';
  /** The command line or URL. */
  target: string;
  enabled: boolean;
  state: 'idle' | 'starting' | 'ready' | 'error' | 'closed';
  tools: number;
  error?: string;
}

export interface HunkView {
  header: string;
  lines: Array<{ type: ' ' | '+' | '-'; text: string }>;
  /** Lines not shown because the hunk is long. */
  hidden: number;
}

/** A pasted or dropped image: base64 data for the model, a small JPEG data URL for the chat. */
export interface ImageAttachment {
  name: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
  thumb?: string;
}

/** A question the desktop app asks inside the UI (VS Code uses its own dialogs instead). */
export type DialogView =
  | { kind: 'message'; level: 'info' | 'warning' | 'error'; text: string; detail?: string; modal: boolean; actions: string[] }
  | { kind: 'input'; title?: string; prompt?: string; placeholder?: string; value?: string; password?: boolean; error?: string }
  | { kind: 'pick'; title?: string; items: Array<{ label: string; description?: string; detail?: string; separator?: boolean; picked?: boolean }> }
  | { kind: 'diff'; title: string; diff: string };

export type SettingsTab = 'agents' | 'providers' | 'skills' | 'mcp' | 'control';

export type ToWebview =
  | { type: 'init'; session: SessionView; config: ConfigView; taskId?: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'config'; config: ConfigView }
  | { type: 'showAgents' }
  | { type: 'showSettings'; tab?: SettingsTab }
  | { type: 'showHistory' }
  | { type: 'history'; tasks: TaskSummary[]; currentId?: string }
  /** Desktop: the tasks of the recent folders, for the session list; taskId: the task open now (saved or not). */
  | { type: 'sessions'; groups: SessionGroup[]; taskId?: string; organizer: SessionOrganizerView }
  | { type: 'fileMatches'; query: string; files: string[] }
  | { type: 'hunks'; path: string; hunks: HunkView[] }
  | { type: 'dialog'; id: string; dialog: DialogView }
  | { type: 'closeDialog'; id: string }
  /** Put text into the message box (e.g. a message the user went back to, to edit and resend). */
  | { type: 'setInput'; text: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; files?: string[]; skills?: string[]; images?: ImageAttachment[] }
  | { type: 'stop' }
  /** Go back to just before this user message (conversation and files). */
  | { type: 'rewind'; id: string }
  /** A new task; with a folder (desktop), in that recent folder. */
  | { type: 'newTask'; folder?: string }
  | { type: 'compact' }
  | { type: 'approve'; id: string; approved: boolean; feedback?: string; always?: boolean }
  | { type: 'previewApproval'; id: string }
  | { type: 'setMode'; mode: PermissionMode }
  | { type: 'setAgent'; agent: string; provider: string; model: string }
  | { type: 'customModel'; agent: string }
  | { type: 'setSetting'; key: string; value: unknown }
  | { type: 'setApiKey'; provider?: string }
  | { type: 'clearApiKey'; provider: string }
  | { type: 'addProvider'; preset: string }
  | { type: 'removeProvider'; id: string }
  | { type: 'loadModels'; provider: string }
  | { type: 'checkClaudeCode' }
  | { type: 'updateClaudeCode' }
  /** Continue the task in an external agent; text: what the user typed but did not send. */
  | { type: 'handoff'; agent: string; text?: string }
  | { type: 'checkForUpdates' }
  /** Look for a newer Orka release now. */
  | { type: 'checkAppUpdate' }
  /** Open the release page of the update found. */
  | { type: 'openRelease' }
  | { type: 'pickClaudeExecutable' }
  | { type: 'resetClaudeExecutable' }
  | { type: 'initMemory' }
  | { type: 'openSettings' }
  | { type: 'listTasks' }
  | { type: 'listSessions' }
  /** Desktop session list: the user's own groups and hidden sessions. */
  | ({ type: 'organizeSessions' } & SessionOrganizeOp)
  /** folder: a recent folder the task belongs to (desktop session list); default the current one. */
  | { type: 'openTask'; id: string; folder?: string }
  | { type: 'deleteTask'; id: string; folder?: string }
  | { type: 'searchFiles'; query: string }
  | { type: 'openDiff'; path: string }
  | { type: 'openFile'; path: string }
  | { type: 'acceptChange'; path: string }
  | { type: 'revertChange'; path: string }
  | { type: 'getHunks'; path: string }
  | { type: 'revertHunk'; path: string; index: number }
  | { type: 'keepHunk'; path: string; index: number }
  | { type: 'acceptAll' }
  | { type: 'revertAll' }
  | { type: 'toggleSkill'; name: string; enabled: boolean }
  | { type: 'openSkill'; name: string }
  | { type: 'customizeSkill'; name: string }
  | { type: 'newSkill' }
  | { type: 'openSkillsFolder' }
  | { type: 'reloadSkills' }
  | { type: 'selectFolder'; path: string }
  | { type: 'toggleMcpServer'; name: string; enabled: boolean }
  | { type: 'importMcp' }
  | { type: 'restartMcp' }
  | { type: 'editMcpServers' }
  /** The answer to a dialog: the action, the text entered or the index picked; undefined = cancelled. */
  | { type: 'dialogResult'; id: string; value?: string | number }
  /** Desktop: work in another folder (a recent one, or pick one when path is empty). */
  | { type: 'openFolder'; path?: string };
