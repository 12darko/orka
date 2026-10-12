import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type { AIProvider } from './AIProvider';
import { ClaudeCodeProvider } from './ClaudeCodeProvider';
import { ClaudeProvider, type ClaudeEffort } from './ClaudeProvider';
import { GeminiProvider } from './GeminiProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { MODEL_CATALOG } from './catalog';

export * from './AIProvider';
export { ClaudeProvider, DEFAULT_CLAUDE_MODEL, type ClaudeEffort, type ClaudeProviderOptions } from './ClaudeProvider';
export { OpenAIProvider, DEFAULT_OPENAI_MODEL, type OpenAIProviderOptions } from './OpenAIProvider';
export { GeminiProvider, DEFAULT_GEMINI_MODEL, type GeminiProviderOptions } from './GeminiProvider';
export { ClaudeCodeProvider, resolveClaudeExecutable, type ClaudeCodeProviderOptions } from './ClaudeCodeProvider';
export * from './textToolProtocol';
export { describeModel, inferModel, isChatModelId, MODEL_CATALOG, type ModelInfo } from './catalog';

export type ProviderKind = 'claude' | 'openai' | 'gemini' | 'claude-code';

export interface ProviderInfo {
  kind: ProviderKind;
  label: string;
  /** "apiKey": needs a key; "local": runs a locally installed, logged-in CLI. */
  auth: 'apiKey' | 'local';
  /** Environment variable accepted as the key. */
  envKey?: string;
  defaultModel: string;
  /** Suggestions for pickers; any other model id can be typed in. */
  models: string[];
}

export const PROVIDERS: Record<ProviderKind, ProviderInfo> = {
  claude: {
    kind: 'claude',
    label: 'Claude API',
    auth: 'apiKey',
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-5-5',
    models: MODEL_CATALOG.claude.map((m) => m.id),
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI API',
    auth: 'apiKey',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-6-astra',
    models: MODEL_CATALOG.openai.map((m) => m.id),
  },
  gemini: {
    kind: 'gemini',
    label: 'Gemini API',
    auth: 'apiKey',
    envKey: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3.8-flash',
    models: MODEL_CATALOG.gemini.map((m) => m.id),
  },
  'claude-code': {
    kind: 'claude-code',
    label: 'Claude Code (local)',
    auth: 'local',
    defaultModel: 'default',
    models: MODEL_CATALOG['claude-code'].map((m) => m.id),
  },
};

export const PROVIDER_KINDS = Object.keys(PROVIDERS) as ProviderKind[];

/**
 * Ready-made OpenAI-compatible endpoints. Any other company or local server works too via a
 * custom base URL; model ids are loaded from the endpoint itself rather than hard-coded.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  baseURL: string;
  requiresKey: boolean;
  /** Where to get a key. */
  keyUrl?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', requiresKey: true, keyUrl: 'https://openrouter.ai/keys' },
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', requiresKey: true, keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'xai', label: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1', requiresKey: true, keyUrl: 'https://console.x.ai' },
  { id: 'mistral', label: 'Mistral', baseURL: 'https://api.mistral.ai/v1', requiresKey: true, keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'groq', label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', requiresKey: true, keyUrl: 'https://console.groq.com/keys' },
  { id: 'together', label: 'Together AI', baseURL: 'https://api.together.xyz/v1', requiresKey: true, keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'ollama', label: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', requiresKey: false },
  { id: 'lmstudio', label: 'LM Studio (local)', baseURL: 'http://localhost:1234/v1', requiresKey: false },
];

export type ProviderConfig =
  | { kind: 'claude'; apiKey: string; model?: string; effort?: ClaudeEffort; refusalFallback?: boolean }
  | { kind: 'openai'; apiKey: string; model?: string; baseURL?: string; reasoningEffort?: 'low' | 'medium' | 'high' }
  | { kind: 'gemini'; apiKey: string; model?: string; thinkingLevel?: 'low' | 'medium' | 'high'; baseURL?: string }
  | { kind: 'claude-code'; model?: string; effort?: ClaudeEffort; executable?: string }
  /** Any OpenAI-compatible endpoint the user adds (OpenRouter, DeepSeek, Ollama, ...). */
  | { kind: 'custom'; id: string; label: string; baseURL: string; apiKey?: string; model?: string };

export function createProvider(config: ProviderConfig): AIProvider {
  switch (config.kind) {
    case 'claude':
      return new ClaudeProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'gemini':
      return new GeminiProvider(config);
    case 'claude-code':
      return new ClaudeCodeProvider(config);
    case 'custom':
      return new OpenAIProvider({
        apiKey: config.apiKey ?? '',
        baseURL: config.baseURL,
        model: config.model,
        providerId: `custom:${config.id}`,
        label: config.label,
      });
  }
}

/** Ask the provider which models it serves (for model pickers). */
export async function listModels(config: ProviderConfig): Promise<string[]> {
  const ids: string[] = [];
  switch (config.kind) {
    case 'openai':
    case 'custom': {
      const client = new OpenAI({ apiKey: config.apiKey || 'not-needed', baseURL: config.baseURL || undefined, maxRetries: 1, timeout: 20_000 });
      for await (const model of client.models.list()) ids.push(model.id);
      break;
    }
    case 'claude': {
      const client = new Anthropic({ apiKey: config.apiKey, maxRetries: 1, timeout: 20_000 });
      for await (const model of client.models.list()) ids.push(model.id);
      break;
    }
    case 'gemini': {
      const client = new GoogleGenAI({ apiKey: config.apiKey });
      for await (const model of await client.models.list()) {
        if (model.name && (!model.supportedActions || model.supportedActions.includes('generateContent'))) {
          ids.push(model.name.replace(/^models\//, ''));
        }
      }
      break;
    }
    case 'claude-code':
      return PROVIDERS['claude-code'].models;
  }
  return [...new Set(ids)].sort();
}
