import type { AssistantMessage, ChatMessage, ToolSpec, Usage } from '../types';

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

/** Incremental events emitted while a response streams in. */
export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'notice'; message: string };

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'other';

export interface ChatResponse {
  message: AssistantMessage;
  stopReason: StopReason;
  /** Extra detail for refusals and unusual stops. */
  stopDetail?: string;
  usage: Usage;
  /** The model that actually served the response (can differ after a fallback). */
  model: string;
}

/**
 * The only thing the orchestrator knows about a model vendor. Adding Gemini, OpenRouter or a
 * custom endpoint means implementing this interface - nothing else changes.
 */
export interface AIProvider {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  chat(request: ChatRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<ChatResponse>;
  /** Release long-lived resources (e.g. local CLI processes). */
  dispose?(): void;
}

export type ProviderErrorKind = 'auth' | 'rate_limit' | 'bad_request' | 'network' | 'server' | 'aborted' | 'other';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
    /** A fix the UI can offer next to the error, e.g. "claudeUpdate". */
    readonly action?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class AbortedError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortedError';
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof AbortedError ||
    (error instanceof ProviderError && error.kind === 'aborted') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
