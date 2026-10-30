import {
  type ClaudeEffort,
  DEFAULT_SUBAGENTS,
  isPrice,
  readHooks,
  type McpServerConfig,
  type OrchestratorSettings,
  type PermissionMode,
  type PermissionOverrides,
  PROVIDER_KINDS,
  PROVIDERS,
  type PriceTable,
  type ProviderKind,
  type SupervisorSettings,
} from '@orka/core';

export interface Disposable {
  dispose(): void;
}

/**
 * Where the settings live: VS Code's configuration ("orka.*"), or the desktop app's
 * settings file. Keys are relative to that section, e.g. "claudeCode.model".
 */
export interface SettingsStore {
  get<T>(key: string, fallback: T): T;
  /** The user set this key (anywhere), rather than relying on its default. */
  isSet(key: string): boolean;
  /**
   * Where the effective value comes from: the user's own settings, or the open folder's (which a
   * cloned repository controls). Stores without per-folder settings omit it.
   */
  scopeOf?(key: string): 'user' | 'workspace' | undefined;
  update(key: string, value: unknown, options?: { preferGlobal?: boolean }): Promise<void>;
  onDidChange(listener: () => void): Disposable;
}

/**
 * A built-in provider, a user-added OpenAI-compatible endpoint ("custom:<id>"), or (main agent
 * only) a coding agent Orka drives over ACP ("agent:<id>", e.g. "agent:gemini", "agent:custom:<slug>").
 */
export type ProviderRef = ProviderKind | `custom:${string}` | `agent:${string}`;

export function isAgentRef(ref: string): ref is `agent:${string}` {
  return ref.startsWith('agent:');
}

/** An ACP agent the user added: a name and the command line that starts its ACP server. */
export interface CustomAgentSetting {
  name: string;
  command: string;
  args: string[];
}

/** Setting key holding each built-in provider's default model. */
export const MODEL_SETTING: Record<ProviderKind, string> = {
  claude: 'claude.model',
  openai: 'openai.model',
  gemini: 'gemini.model',
  'claude-code': 'claudeCode.model',
};

/** Any OpenAI-compatible endpoint the user added (OpenRouter, DeepSeek, xAI, Ollama, ...). */
export interface CustomProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  requiresKey: boolean;
  /** Model ids for the pickers (usually loaded from the endpoint). */
  models: string[];
  defaultModel: string;
}

export interface AgentChoice {
  provider: ProviderRef | 'inherit';
  /** Empty = the provider's default model. */
  model: string;
}

export interface AppSettings {
  provider: ProviderRef;
  /** The user chose the main provider (in the settings or the UI), rather than relying on the default. */
  providerExplicit: boolean;
  models: Record<ProviderKind, string>;
  customProviders: CustomProviderDef[];
  claude: { effort: ClaudeEffort; refusalFallback: boolean };
  openai: { baseUrl: string; reasoningEffort?: 'low' | 'medium' | 'high' };
  gemini: { thinkingLevel?: 'low' | 'medium' | 'high' };
  /**
   * The local Claude Code CLI as a provider. Off until the user turns it on: it runs on the user's
   * own Claude Code login, which is theirs to use within Anthropic's terms.
   */
  claudeCode: { enabled: boolean; effort?: ClaudeEffort; path?: string; autoUpdate: boolean };
  subagents: { enabled: boolean; agents: Record<string, AgentChoice> };
  supervisor: SupervisorSettings & AgentChoice;
  /** Where the main agent continues when its provider hits a limit ("inherit" = off). */
  fallback: AgentChoice;
  /** A lighter model for short questions ("inherit" = off). */
  light: AgentChoice;
  mode: PermissionMode;
  overrides: PermissionOverrides;
  orchestrator: OrchestratorSettings & { compaction: { auto: boolean; thresholdTokens: number } };
  shell?: string;
  /** "auto" follows the app's display language, then the operating system's. */
  language: 'auto' | 'en' | 'tr';
  pricing: PriceTable;
  skills: { enabled: boolean; disabled: string[] };
  /** MCP servers from the settings (the workspace .mcp.json is read separately). */
  mcp: { enabled: boolean; servers: Record<string, McpServerConfig> };
  /** Snapshot the workspace around terminal commands so their file changes can be reverted. */
  trackCommandChanges: boolean;
  /** Highlight AI changes in the editor with Keep / Revert code lenses (VS Code). */
  inlineReview: boolean;
  /** Chrome/Edge/Chromium for the browser tool; empty = auto-detect. */
  browserPath?: string;
  /** The hooks come from the open folder's settings (they run commands, so they need the user's OK first). */
  hooksFromWorkspace: boolean;
  /** Look for a newer Orka release once a day (notify only). */
  checkUpdates: boolean;
  /**
   * Coding agents (Gemini CLI, Codex, Copilot, Cursor, custom) the user turned on as possible main
   * agents; their executable paths and custom agents come only from the user's own settings.
   */
  agentClis: { enabled: string[]; paths: Record<string, string>; custom: CustomAgentSetting[] };
  /** The desktop app's window: sessions and side panels ("ide") or one column ("classic"), and its colors. */
  desktop: { layout: 'ide' | 'classic'; theme: 'system' | 'light' | 'dark' };
}

export function isCustomRef(ref: string): ref is `custom:${string}` {
  return ref.startsWith('custom:');
}

export function readSettings(c: SettingsStore): AppSettings {
  const optional = <T extends string>(key: string) => (c.get<string>(key, '') || undefined) as T | undefined;
  const models = {} as Record<ProviderKind, string>;
  for (const kind of PROVIDER_KINDS) models[kind] = c.get<string>(MODEL_SETTING[kind], '').trim() || PROVIDERS[kind].defaultModel;

  const customProviders = readCustomProviders(c.get<unknown[]>('customProviders', []));
  const claudeCodeEnabled = c.get<boolean>('claudeCode.enabled', false);
  const agentClis = readAgentClis(c);
  const valid = (value: string | undefined): ProviderRef | undefined => {
    if (!value) return undefined;
    if (value === 'claude-code' && !claudeCodeEnabled) return undefined;
    if (PROVIDER_KINDS.includes(value as ProviderKind)) return value as ProviderKind;
    if (isCustomRef(value) && customProviders.some((p) => `custom:${p.id}` === value)) return value;
    return undefined;
  };

  const configured = c.get<Record<string, Partial<AgentChoice>>>('subagents.agents', {}) ?? {};
  const agents: Record<string, AgentChoice> = {};
  for (const profile of DEFAULT_SUBAGENTS) {
    const choice = configured[profile.name] ?? {};
    agents[profile.name] = { provider: valid(choice.provider) ?? 'inherit', model: (choice.model ?? '').trim() };
  }

  // Only the main agent can be an agent CLI, and only one the user turned on.
  const mainRef = c.get<string>('provider', 'claude');
  const agentMain = typeof mainRef === 'string' && isAgentRef(mainRef) && agentClis.enabled.includes(mainRef.slice('agent:'.length)) ? (mainRef as ProviderRef) : undefined;

  return {
    provider: agentMain ?? valid(mainRef) ?? 'claude',
    providerExplicit: c.isSet('provider'),
    models,
    customProviders,
    claude: { effort: c.get<ClaudeEffort>('claude.effort', 'medium'), refusalFallback: c.get<boolean>('claude.refusalFallback', true) },
    openai: {
      baseUrl: c.get<string>('openai.baseUrl', '').trim() || 'https://api.openai.com/v1',
      reasoningEffort: optional('openai.reasoningEffort'),
    },
    gemini: { thinkingLevel: optional('gemini.thinkingLevel') },
    claudeCode: {
      enabled: claudeCodeEnabled,
      effort: optional('claudeCode.effort'),
      path: c.get<string>('claudeCode.path', '').trim() || undefined,
      autoUpdate: c.get<boolean>('claudeCode.autoUpdate', false),
    },
    subagents: { enabled: c.get<boolean>('subagents.enabled', true), agents },
    supervisor: {
      enabled: c.get<boolean>('supervisor.enabled', true),
      provider: valid(c.get<string>('supervisor.provider', 'inherit')) ?? 'inherit',
      model: c.get<string>('supervisor.model', '').trim(),
      frequency: (['checkpoints', 'every_turn', 'on_changes', 'final_only'] as const).find((f) => f === c.get<string>('supervisor.frequency', '')) ?? 'checkpoints',
      maxInterventions: Math.max(1, c.get<number>('supervisor.maxInterventions', 5)),
      mode: c.get<string>('supervisor.mode', '') === 'blocking' ? 'blocking' : 'parallel',
    },
    light: {
      provider: valid(c.get<string>('routing.provider', 'inherit')) ?? 'inherit',
      model: c.get<string>('routing.model', '').trim(),
    },
    fallback: {
      provider: valid(c.get<string>('fallback.provider', 'inherit')) ?? 'inherit',
      model: c.get<string>('fallback.model', '').trim(),
    },
    mode: c.get<PermissionMode>('permissionMode', 'balanced'),
    overrides: {
      fileEdit: c.get('permissions.fileEdit', 'mode'),
      terminal: c.get('permissions.terminal', 'mode'),
      git: c.get('permissions.git', 'mode'),
      delete: c.get('permissions.delete', 'mode'),
      network: c.get('permissions.network', 'mode'),
    },
    orchestrator: {
      maxIterations: Math.max(1, c.get<number>('maxIterations', 60)),
      autoVerify: c.get<boolean>('autoVerify', true),
      commandTimeoutMs: Math.max(5, c.get<number>('commandTimeoutSeconds', 180)) * 1000,
      customInstructions: c.get<string>('customInstructions', ''),
      maxParallelSubagents: Math.min(8, Math.max(1, c.get<number>('subagents.maxParallel', 3))),
      parallelWorkers: c.get<boolean>('subagents.parallelWorkers', true),
      compaction: {
        auto: c.get<boolean>('compaction.auto', true),
        thresholdTokens: Math.max(10_000, c.get<number>('compaction.thresholdTokens', 150_000)),
      },
      tokenBudget: Math.max(0, c.get<number>('tokenBudget', 0)),
      hooks: readHooks(c.get<unknown>('hooks', {})),
      learnLessons: c.get<boolean>('memory.learn', true),
    },
    shell: c.get<string>('shell', '').trim() || undefined,
    language: (['en', 'tr'] as const).find((l) => l === c.get<string>('language', '')) ?? 'auto',
    pricing: readPricing(c.get<Record<string, unknown>>('pricing', {})),
    skills: {
      enabled: c.get<boolean>('skills.enabled', true),
      disabled: (c.get<unknown[]>('skills.disabled', []) ?? []).filter((s): s is string => typeof s === 'string'),
    },
    trackCommandChanges: c.get<boolean>('trackCommandChanges', true),
    inlineReview: c.get<boolean>('inlineReview', true),
    browserPath: c.get<string>('browser.path', '').trim() || undefined,
    hooksFromWorkspace: c.scopeOf?.('hooks') === 'workspace',
    mcp: { enabled: c.get<boolean>('mcp.enabled', true), servers: readMcpServers(c.get<Record<string, unknown>>('mcpServers', {})) },
    checkUpdates: c.get<boolean>('updates.check', true) !== false,
    agentClis,
    desktop: {
      layout: c.get<string>('desktop.layout', '') === 'classic' ? 'classic' : 'ide',
      theme: (['light', 'dark'] as const).find((v) => v === c.get<string>('desktop.theme', '')) ?? 'system',
    },
  };
}

/** MCP server entries: a command (stdio) or a url (Streamable HTTP); anything malformed is skipped. */
export function readMcpServers(raw: Record<string, unknown> | undefined): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined);
  const record = (v: unknown) =>
    v && typeof v === 'object' ? (Object.fromEntries(Object.entries(v).filter(([, s]) => typeof s === 'string')) as Record<string, string>) : undefined;
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (!/^[\w.-]{1,40}$/.test(name) || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const disabled = v.disabled === true ? true : undefined;
    if (typeof v.url === 'string' && /^https?:\/\//.test(v.url)) out[name] = { url: v.url, headers: record(v.headers), disabled };
    else if (typeof v.command === 'string' && v.command.trim())
      out[name] = { command: v.command, args: strings(v.args), env: record(v.env), cwd: typeof v.cwd === 'string' ? v.cwd : undefined, disabled };
  }
  return out;
}

const AGENT_ID = /^(?:[a-z][a-z0-9-]{0,39}|custom:[a-z0-9][a-z0-9-]{0,39})$/;

/** The agent CLIs block; ids, paths and command lines that do not look right are dropped. */
function readAgentClis(c: SettingsStore): AppSettings['agentClis'] {
  const custom: CustomAgentSetting[] = [];
  for (const item of c.get<unknown[]>('agentClis.custom', []) ?? []) {
    if (!item || typeof item !== 'object') continue;
    const def = item as Partial<CustomAgentSetting>;
    const name = typeof def.name === 'string' ? def.name.trim().slice(0, 60) : '';
    const command = typeof def.command === 'string' ? def.command.trim() : '';
    if (!name || !command || command.length > 1000) continue;
    const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string').slice(0, 50) : [];
    custom.push({ name, command, args });
  }
  const paths: Record<string, string> = {};
  for (const [id, value] of Object.entries(c.get<Record<string, unknown>>('agentClis.paths', {}) ?? {})) {
    if (AGENT_ID.test(id) && typeof value === 'string' && value.trim()) paths[id] = value.trim();
  }
  const enabled = (c.get<unknown[]>('agentClis.enabled', []) ?? []).filter((id): id is string => typeof id === 'string' && AGENT_ID.test(id));
  return { enabled: [...new Set(enabled)], paths, custom };
}

function readPricing(raw: Record<string, unknown> | undefined): PriceTable {
  const table: PriceTable = {};
  for (const [key, value] of Object.entries(raw ?? {})) if (key.includes('/') && isPrice(value)) table[key] = value;
  return table;
}

function readCustomProviders(raw: unknown[] | undefined): CustomProviderDef[] {
  const out: CustomProviderDef[] = [];
  for (const item of raw ?? []) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Partial<CustomProviderDef>;
    if (!p.id || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(p.id) || !p.baseUrl || !/^https?:\/\//.test(p.baseUrl)) continue;
    if (out.some((o) => o.id === p.id)) continue;
    const models = Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === 'string').slice(0, 500) : [];
    out.push({
      id: p.id,
      label: (p.label || p.id).slice(0, 60),
      baseUrl: p.baseUrl,
      requiresKey: p.requiresKey !== false,
      models,
      defaultModel: typeof p.defaultModel === 'string' && p.defaultModel ? p.defaultModel : (models[0] ?? ''),
    });
  }
  return out;
}

const int = (min: number, max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Shells offered in the settings UI ('' = platform default). Other values only via the settings file. */
export const SHELL_CHOICES = process.platform === 'win32' ? ['', 'powershell.exe', 'pwsh.exe', 'cmd.exe'] : ['', '/bin/bash', '/bin/zsh', '/bin/sh'];

/** Settings the chat UI may change directly, with a validator each (everything else goes through commands). */
export const WEBVIEW_SETTINGS: Record<string, (value: unknown) => boolean> = {
  permissionMode: (v) => v === 'ask' || v === 'balanced' || v === 'autonomous',
  'permissions.fileEdit': (v) => ['mode', 'auto', 'ask'].includes(v as string),
  'permissions.terminal': (v) => ['mode', 'auto', 'askDangerous', 'ask'].includes(v as string),
  'permissions.git': (v) => ['mode', 'auto', 'ask'].includes(v as string),
  'permissions.delete': (v) => ['mode', 'auto', 'ask'].includes(v as string),
  'permissions.network': (v) => ['mode', 'auto', 'ask'].includes(v as string),
  autoVerify: (v) => typeof v === 'boolean',
  trackCommandChanges: (v) => typeof v === 'boolean',
  inlineReview: (v) => typeof v === 'boolean',
  maxIterations: int(1, 500),
  commandTimeoutSeconds: int(5, 3600),
  shell: (v) => SHELL_CHOICES.includes(v as string),
  customInstructions: (v) => typeof v === 'string' && (v as string).length < 20_000,
  'compaction.auto': (v) => typeof v === 'boolean',
  'compaction.thresholdTokens': int(10_000, 2_000_000),
  'subagents.enabled': (v) => typeof v === 'boolean',
  'subagents.maxParallel': int(1, 8),
  'subagents.parallelWorkers': (v) => typeof v === 'boolean',
  'supervisor.enabled': (v) => typeof v === 'boolean',
  'supervisor.frequency': (v) => ['checkpoints', 'every_turn', 'on_changes', 'final_only'].includes(v as string),
  'supervisor.maxInterventions': int(1, 50),
  'supervisor.mode': (v) => v === 'parallel' || v === 'blocking',
  tokenBudget: int(0, 100_000_000),
  language: (v) => v === 'auto' || v === 'en' || v === 'tr',
  'skills.enabled': (v) => typeof v === 'boolean',
  'memory.learn': (v) => typeof v === 'boolean',
  'mcp.enabled': (v) => typeof v === 'boolean',
  'claude.effort': (v) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(v as string),
  'claude.refusalFallback': (v) => typeof v === 'boolean',
  'openai.baseUrl': (v) => typeof v === 'string' && /^https?:\/\/\S+$/.test(v as string),
  'openai.reasoningEffort': (v) => ['', 'low', 'medium', 'high'].includes(v as string),
  'gemini.thinkingLevel': (v) => ['', 'low', 'medium', 'high'].includes(v as string),
  'claudeCode.enabled': (v) => typeof v === 'boolean',
  'claudeCode.autoUpdate': (v) => typeof v === 'boolean',
  'claudeCode.effort': (v) => ['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(v as string),
  'updates.check': (v) => typeof v === 'boolean',
  // Desktop only (the VS Code extension ignores them).
  'desktop.layout': (v) => v === 'ide' || v === 'classic',
  'desktop.theme': (v) => v === 'system' || v === 'light' || v === 'dark',
};

/** Settings only the desktop app has. */
export const DESKTOP_SETTINGS = new Set(['desktop.layout', 'desktop.theme']);

/**
 * Settings a folder's own settings must not change: programs Orka starts, where API keys are sent,
 * and permission overrides. A cloned repository controls its folder settings, so these only come
 * from the user's own settings (VS Code: machine scope) and are always written there.
 */
export const MACHINE_SETTINGS = new Set([
  'shell',
  'claudeCode.path',
  'agentClis.paths',
  'agentClis.custom',
  'browser.path',
  'mcpServers',
  'customProviders',
  'openai.baseUrl',
  'permissions.fileEdit',
  'permissions.terminal',
  'permissions.git',
  'permissions.delete',
  'permissions.network',
]);

/** Settings that describe the user rather than a project; written globally unless already set elsewhere. */
export const USER_LEVEL_SETTINGS = new Set([
  'mcp.enabled',
  'claudeCode.enabled',
  'claudeCode.autoUpdate',
  'language',
  'skills.disabled',
  'skills.enabled',
  'pricing',
  'updates.check',
  'agentClis.enabled',
  ...DESKTOP_SETTINGS,
  ...MACHINE_SETTINGS,
]);
