import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  PROVIDERS,
  resolveClaudeExecutable,
  type ClaudeEffort,
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
  mcpServers?: Record<string, McpServerConfig>;
  skills?: { enabled?: boolean; disabled?: string[] };
  /** Snapshot the files terminal commands change, so /undo covers them too (needs git). */
  trackCommandChanges?: boolean;
  browserPath?: string;
  /** Commands run after edits ("afterEdit") and before the agent finishes ("beforeFinish"); see the README. */
  hooks?: { afterEdit?: unknown[]; beforeFinish?: unknown[] };
  /** learn: after a task that changed code, add lasting lessons to .project-ai/lessons.md (default true; needs that folder). */
  memory?: { learn?: boolean };
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

/** "claude-code:opus" -> { provider: "claude-code", model: "opus" }. */
export function parseChoice(value: string): AgentChoice {
  const at = value.indexOf(':');
  return at > 0 ? { provider: value.slice(0, at), model: value.slice(at + 1) || undefined } : { provider: value };
}
