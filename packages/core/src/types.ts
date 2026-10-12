/**
 * Provider-neutral conversation model shared by the orchestrator, the providers and every
 * front-end (VS Code, desktop, CLI). Providers translate to/from their wire formats.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  content: string;
  isError?: boolean;
  /** Images the tool produced (e.g. a browser screenshot), for models that can see. */
  images?: ImageBlock[];
}

/** Model reasoning / progress notes. Display-only: never sent back in neutral form. */
export interface ReasoningBlock {
  type: 'reasoning';
  text: string;
}

/** An image the user attached (e.g. a pasted screenshot), base64-encoded. */
export interface ImageBlock {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
}

export interface UserMessage {
  role: 'user';
  content: Array<TextBlock | ToolResultBlock | ImageBlock>;
}

export interface AssistantMessage {
  role: 'assistant';
  content: Array<TextBlock | ToolCallBlock | ReasoningBlock>;
  /**
   * The provider's own content exactly as it was returned (thinking blocks with signatures,
   * fallback markers, ...). Replayed verbatim when the same provider continues the
   * conversation, so the history stays append-only and byte-stable.
   */
  native?: { provider: string; content: unknown };
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export function messageText(message: ChatMessage): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
