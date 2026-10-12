import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { AssistantMessage, ChatMessage, ToolSpec, Usage } from '../types';
import {
  AbortedError,
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  ProviderError,
  type ProviderStreamEvent,
  type StopReason,
} from './AIProvider';

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  /** Any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, Azure, local servers). */
  baseURL?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  /** Identity for custom endpoints (e.g. "custom:openrouter"); defaults to "openai". */
  providerId?: string;
  label?: string;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-6-astra';

const PROVIDER_ID = 'openai';

/** Key under which unparseable tool arguments are surfaced, so schema validation rejects them. */
export const INVALID_JSON_KEY = '__invalid_json';

export class OpenAIProvider implements AIProvider {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.model = options.model || DEFAULT_OPENAI_MODEL;
    this.id = options.providerId ?? PROVIDER_ID;
    // Local servers (Ollama, LM Studio) need no key, but the SDK insists on one.
    this.client = new OpenAI({ apiKey: options.apiKey || 'not-needed', baseURL: options.baseURL || undefined, maxRetries: 4 });
    this.label = options.label ?? (options.baseURL && !options.baseURL.includes('api.openai.com') ? 'OpenAI-compatible' : 'OpenAI');
  }

  async chat(request: ChatRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<ChatResponse> {
    const params: ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: toOpenAIMessages(request.system, request.messages),
      ...(request.tools.length ? { tools: request.tools.map(toOpenAITool) } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(this.options.maxTokens ? { max_completion_tokens: this.options.maxTokens } : {}),
      ...(this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {}),
    };

    let text = '';
    let finishReason: string | null = null;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let servedModel = this.model;
    const calls = new Map<number, { id: string; name: string; args: string }>();

    try {
      const stream = await this.client.chat.completions.create(params, { signal: request.signal });
      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        if (chunk.model) servedModel = chunk.model;
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            cacheWriteTokens: 0,
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          onEvent({ type: 'text_delta', text: delta.content });
        }
        for (const call of delta?.tool_calls ?? []) {
          let entry = calls.get(call.index);
          if (!entry) {
            entry = { id: call.id ?? `call_${call.index}_${Date.now()}`, name: '', args: '' };
            calls.set(call.index, entry);
          }
          if (call.id) entry.id = call.id;
          if (call.function?.name) {
            const first = !entry.name;
            entry.name += call.function.name;
            if (first) onEvent({ type: 'tool_call_start', id: entry.id, name: entry.name });
          }
          if (call.function?.arguments) entry.args += call.function.arguments;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (error) {
      if (error instanceof OpenAI.APIUserAbortError || request.signal?.aborted) throw new AbortedError();
      throw mapApiError(error);
    }

    const content: AssistantMessage['content'] = [];
    if (text) content.push({ type: 'text', text });
    for (const [, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      content.push({ type: 'tool_call', id: call.id, name: call.name, input: parseArguments(call.args) });
    }

    return {
      message: { role: 'assistant', content },
      stopReason: mapFinishReason(finishReason, calls.size > 0),
      stopDetail: finishReason === 'content_filter' ? 'content_filter' : undefined,
      usage,
      model: servedModel,
    };
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { [INVALID_JSON_KEY]: raw };
  } catch {
    return { [INVALID_JSON_KEY]: raw };
  }
}

function toOpenAITool(tool: ToolSpec): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  };
}

export function toOpenAIMessages(system: string, messages: ChatMessage[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      const toolCalls = message.content
        .filter((b) => b.type === 'tool_call')
        .map((b) => {
          const call = b as { id: string; name: string; input: Record<string, unknown> };
          return {
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          };
        });
      out.push({
        role: 'assistant',
        content: text || (toolCalls.length ? null : '(no content)'),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // Tool results must directly follow the assistant turn that requested them.
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          content: block.isError ? `ERROR: ${block.content}` : block.content || '(empty)',
        });
      }
    }
    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n\n');
    const images = [
      ...message.content.flatMap((b) => (b.type === 'tool_result' && b.images ? b.images : [])),
      ...message.content.filter((b) => b.type === 'image'),
    ];
    if (images.length) {
      out.push({
        role: 'user',
        content: [
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...images.map((b) => {
            const image = b as { mediaType: string; data: string };
            return { type: 'image_url' as const, image_url: { url: `data:${image.mediaType};base64,${image.data}` } };
          }),
        ],
      });
    } else if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

function mapFinishReason(reason: string | null, hasToolCalls: boolean): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'stop':
      return hasToolCalls ? 'tool_use' : 'end_turn';
    default:
      return hasToolCalls ? 'tool_use' : 'end_turn';
  }
}

function mapApiError(error: unknown): Error {
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    return new ProviderError(`OpenAI rejected the API key (${error.status}). ${error.message}`, 'auth', error.status);
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new ProviderError(`OpenAI rate limit reached. ${error.message}`, 'rate_limit', error.status);
  }
  if (error instanceof OpenAI.BadRequestError || error instanceof OpenAI.NotFoundError) {
    return new ProviderError(`OpenAI rejected the request: ${error.message}`, 'bad_request', error.status);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ProviderError(`Could not reach the OpenAI API: ${error.message}`, 'network');
  }
  if (error instanceof OpenAI.APIError) {
    return new ProviderError(`OpenAI API error: ${error.message}`, 'server', error.status);
  }
  return error instanceof Error ? error : new Error(String(error));
}
