import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  AGENT_CLIS,
  customAgentEntry,
  PROVIDERS,
  resolveClaudeExecutable,
  t,
  type AgentCliEntry,
  type ClaudeEffort,
  type CustomAgentDefinition,
  type McpServerConfig,
  type PermissionMode,
  type ProviderConfig,
  type ProviderKind,
  type SupervisorFrequency,
} from '@orka/core';

/** Orka's home: config, tasks, snapshots and user skills (shared with the VS Code extension). */
export const ORKA_HOME = process.env.ORKA_HOME || path.join(homedir(), '.orka');
export const CONFIG_FILE = path.join(ORKA_HOME, 'config.json');

export interface AgentChoice {
  provider: string;
  model?: string;
}

export interface CustomEndpoint {
  id: string;
  label?: string;
  /** An OpenAI-compatible endpoint (OpenRouter, DeepSeek, Ollama, LM Studio, ...). */
  baseURL: string;
  model?: string;
  /** Name of the environment variable that holds the key; keys never live in the config. */
  apiKeyEnv?: string;
}

export interface OrkaConfig {
  provider?: string;
  model?: string;
  mode?: PermissionMode;
  /** "auto" (system language), "en" or "tr". */
  language?: string;
  maxIterations?: number;
  /** Pause a request after this many new tokens (0 = no limit). */
  tokenBudget?: number;
  commandTimeoutSeconds?: number;
  customInstructions?: string;
  subagents?: boolean;
  supervisor?: { enabled?: boolean; provider?: string; model?: string; frequency?: SupervisorFrequency; maxInterventions?: number };
  /** A lighter model for simple questions. */
  light?: AgentChoice;
  /** Where to continue when the main provider hits a rate limit or is down. */
  fallback?: AgentChoice;
  custom?: CustomEndpoint[];
  /**
   * The local Claude Code CLI as a provider; off unless `enabled` is true. It runs on the user's
   * own Claude Code login, which is theirs to use within Anthropic's terms.
   */
  claudeCode?: { enabled?: boolean; executable?: string; effort?: ClaudeEffort };
  /**
   * Agent mode: a coding agent CLI the user installed and signed in to (Gemini CLI, Codex, ...)
   * runs as the main agent over ACP ("provider": "agent:<id>"). See docs/EXTERNAL_AGENTS.md.
   */
  agentClis?: {
    /** Agent ids turned on ("gemini", "custom:my-agent"); a "provider" in this file may only name one of these. */
    enabled?: string[];
    /** The executable per agent id, when it is not on PATH. */
    paths?: Record<string, string>;
    /** ACP agents the user added: a name and the exact command line that starts the agent's ACP server. */
    custom?: Array<{ name: string; command: string; args?: string[] }>;
  };
  mcpServers?: Record<string, McpServerConfig>;
  skills?: { enabled?: boolean; disabled?: string[] };
  /** Snapshot the files terminal commands change, so /undo covers them too (needs git). */
  trackCommandChanges?: boolean;
  browserPath?: string;
  /** Commands run after edits ("afterEdit") and before the agent finishes ("beforeFinish"); see the README. */
  hooks?: { afterEdit?: unknown[]; beforeFinish?: unknown[] };
  /** learn: after a task that changed code, add lasting lessons to .project-ai/lessons.md (default true; needs that folder). */
  memory?: { learn?: boolean };
  /** Workers started together run side by side in copies of the project (default true). */
  parallelWorkers?: boolean;
  /** Look for a newer Orka release once a day and mention it at the next start (default true; ORKA_NO_UPDATE_CHECK=1 also turns it off). */
  updateCheck?: boolean;
}

export function loadConfig(file = CONFIG_FILE): { config: OrkaConfig; error?: string } {
  if (!existsSync(file)) return { config: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { config: {}, error: `${file}: expected a JSON object.` };
    return { config: parsed as OrkaConfig };
  } catch (error) {
    return { config: {}, error: `${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const KEY_ENV: Partial<Record<ProviderKind, string[]>> = {
  claude: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

function envKey(kind: ProviderKind, env: NodeJS.ProcessEnv): string | undefined {
  for (const name of KEY_ENV[kind] ?? []) if (env[name]?.trim()) return env[name]!.trim();
  return undefined;
}

export function isProviderKind(id: string): id is ProviderKind {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/** Whether the Claude Code CLI can be found (installed and on PATH or in a known place). */
export function hasClaudeCode(config: OrkaConfig): boolean {
  const exe = resolveClaudeExecutable(config.claudeCode?.executable);
  return path.isAbsolute(exe) ? existsSync(exe) : onPath(exe);
}

function onPath(command: string): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['', ...exts]) if (existsSync(path.join(dir, command + ext.toLowerCase())) || existsSync(path.join(dir, command + ext))) return true;
  }
  return false;
}

export const CLAUDE_CODE_OFF =
  'Claude Code is turned off. To use your local Claude Code CLI as a provider, set "claudeCode": { "enabled": true } in ' +
  `${CONFIG_FILE}. It is unofficial and runs on your own Claude Code login: make sure your use follows Anthropic's terms.`;

/**
 * The provider to use when none is chosen: the configured one, else Claude Code when it is
 * turned on and installed (no key needed), else the first provider with a key in the environment.
 */
export function defaultProvider(config: OrkaConfig, env: NodeJS.ProcessEnv = process.env, claudeCodeInstalled?: boolean): string | undefined {
  if (config.provider) return config.provider;
  if (config.claudeCode?.enabled && (claudeCodeInstalled ?? hasClaudeCode(config))) return 'claude-code';
  return (['claude', 'openai', 'gemini'] as ProviderKind[]).find((kind) => envKey(kind, env));
}

/** Everything needed to create a provider, with the key read from the environment. */
export function providerConfig(choice: AgentChoice, config: OrkaConfig, env: NodeJS.ProcessEnv = process.env): ProviderConfig | { error: string } {
  if (isAgentProvider(choice.provider)) {
    return { error: t('{provider} is an agent CLI: it can only be the main agent, not the Supervisor, the light model, the fallback or a sub-agent.', { provider: choice.provider }) };
  }
  const model = choice.model?.trim() || undefined;
  if (isProviderKind(choice.provider)) {
    const kind = choice.provider;
    if (kind === 'claude-code') {
      if (!config.claudeCode?.enabled) return { error: CLAUDE_CODE_OFF };
      return { kind, model, effort: config.claudeCode?.effort, executable: config.claudeCode?.executable };
    }
    const apiKey = envKey(kind, env);
    if (!apiKey) return { error: `${PROVIDERS[kind].label} needs an API key: set ${KEY_ENV[kind]!.join(' or ')} in the environment.` };
    return { kind, apiKey, model } as ProviderConfig;
  }
  const custom = config.custom?.find((c) => c.id === choice.provider);
  if (!custom) {
    const known = [...Object.keys(PROVIDERS), ...(config.custom ?? []).map((c) => c.id)];
    return { error: `Unknown provider "${choice.provider}". Known: ${known.join(', ')}.` };
  }
  const apiKey = custom.apiKeyEnv ? env[custom.apiKeyEnv]?.trim() : undefined;
  if (custom.apiKeyEnv && !apiKey) return { error: `${custom.label ?? custom.id} needs an API key: set ${custom.apiKeyEnv} in the environment.` };
  return { kind: 'custom', id: custom.id, label: custom.label ?? custom.id, baseURL: custom.baseURL, apiKey, model: model ?? custom.model };
}

/** "claude-code:opus" -> { provider: "claude-code", model: "opus" }; "agent:custom:x" stays whole (an agent picks its own model). */
export function parseChoice(value: string): AgentChoice {
  if (isAgentProvider(value)) return { provider: value };
  const at = value.indexOf(':');
  return at > 0 ? { provider: value.slice(0, at), model: value.slice(at + 1) || undefined } : { provider: value };
}

// ---------------------------------------------------------------- agent CLIs (agent mode)

/** A main agent "agent:<id>" is an agent CLI over ACP; <id> is a catalog id or "custom:<slug>". */
export const AGENT_PREFIX = 'agent:';
/** The <slug> of a custom agent's id, as the apps' settings allow it. */
const CUSTOM_AGENT_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isAgentProvider(id: string): boolean {
  return id.startsWith(AGENT_PREFIX);
}

/** The agents this config knows (the catalog, then its custom agents), and what is wrong in its "agentClis" block. */
export function configuredAgents(config: OrkaConfig): { agents: AgentCliEntry[]; problems: string[] } {
  const agents: AgentCliEntry[] = [...AGENT_CLIS];
  const problems: string[] = [];
  const block: unknown = config.agentClis;
  if (block !== undefined && (!block || typeof block !== 'object' || Array.isArray(block))) {
    return { agents, problems: [t('"agentClis" must be an object with "enabled", "paths" and "custom".')] };
  }
  const custom: unknown = config.agentClis?.custom;
  if (custom !== undefined && !Array.isArray(custom)) problems.push(t('"agentClis.custom" must be a list.'));
  for (const item of Array.isArray(custom) ? (custom as unknown[]) : []) {
    const definition = customDefinition(item);
    if (!definition) {
      problems.push(t('Skipped an entry of "agentClis.custom": it needs a "name" and a "command" ("args" is a list of strings).'));
      continue;
    }
    const entry = customAgentEntry(definition);
    if (!CUSTOM_AGENT_SLUG.test(entry.id.slice('custom:'.length))) {
      problems.push(t('Skipped the custom agent "{name}": its id ({id}) may have at most 40 letters, digits and dashes.', { name: definition.name, id: entry.id }));
    } else if (agents.some((a) => a.id === entry.id)) {
      problems.push(t('Skipped the custom agent "{name}": another one already has the id {id}.', { name: definition.name, id: entry.id }));
    } else {
      agents.push(entry);
    }
  }
  return { agents, problems };
}

function customDefinition(value: unknown): CustomAgentDefinition | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { name, command, args } = value as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim() || typeof command !== 'string' || !command.trim()) return undefined;
  if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === 'string'))) return undefined;
  return { name, command, args: args as string[] | undefined };
}

/** The agent ids turned on in the config. */
export function enabledAgents(config: OrkaConfig): Set<string> {
  const enabled: unknown = config.agentClis?.enabled;
  return new Set(Array.isArray(enabled) ? enabled.filter((id): id is string => typeof id === 'string') : []);
}

/** The executable the user set for an agent, if any. */
export function agentPath(config: OrkaConfig, id: string): string | undefined {
  const paths: unknown = config.agentClis?.paths;
  if (!paths || typeof paths !== 'object' || !Object.prototype.hasOwnProperty.call(paths, id)) return undefined;
  const value: unknown = (paths as Record<string, unknown>)[id];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export interface AgentSelection {
  entry: AgentCliEntry;
  /** The user's path to its executable; without one it is looked up on PATH. */
  path?: string;
}

/**
 * The agent CLI behind "agent:<id>". Any known agent may be chosen on the command line; a
 * "provider" from the config must also be turned on in "agentClis.enabled".
 */
export function resolveAgent(provider: string, config: OrkaConfig, fromCommandLine: boolean): AgentSelection | { error: string } {
  const id = provider.slice(AGENT_PREFIX.length);
  const { agents } = configuredAgents(config);
  const entry = agents.find((a) => a.id === id);
  if (!entry) {
    return { error: t('Unknown agent "{id}". Known: {known}. Add your own ACP agent under "agentClis.custom" in the config.', { id, known: agents.map((a) => a.id).join(', ') }) };
  }
  if (!fromCommandLine && !enabledAgents(config).has(id)) {
    return { error: t('{agent} is not turned on: add "{id}" to "agentClis.enabled" in {file}, or choose it with --provider {provider}.', { agent: entry.label, id, file: CONFIG_FILE, provider }) };
  }
  return { entry, path: agentPath(config, id) };
}
