import { t } from '../i18n';
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  MessageCreateParamsStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
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

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeProviderOptions {
  apiKey: string;
  model?: string;
  effort?: ClaudeEffort;
  /** Retry classifier refusals on Anthropic's recommended fallback model (server-side, beta). */
  refusalFallback?: boolean;
  maxTokens?: number;
  baseURL?: string;
}

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

const PROVIDER_ID = 'claude';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_INVALID_JSON_RETRIES = 2;

/** Models that take adaptive thinking + `output_config.effort` (Claude 4.6 and newer). */
function supportsAdaptiveThinking(model: string): boolean {
  return !/claude-(3|haiku-4|sonnet-4-5|sonnet-4-0|sonnet-4-2|opus-4-0|opus-4-1|opus-4-5|opus-4-2)/.test(model);
}

/** Models that accept `fallbacks: "default"` on the Claude API. */
function supportsDefaultFallback(model: string): boolean {
  return /^claude-(opus-5|fable-5-1|mythos-5-1|sonnet-5-5)/.test(model);
}

export class ClaudeProvider implements AIProvider {
  readonly id = PROVIDER_ID;
  readonly label = 'Claude';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly options: ClaudeProviderOptions) {
    this.model = options.model || DEFAULT_CLAUDE_MODEL;
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: 4 });
  }

  async chat(request: ChatRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<ChatResponse> {
    const params = this.buildParams(request);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.streamOnce(params, request.signal, onEvent);
      } catch (error) {
        if (error instanceof Anthropic.APIUserAbortError || request.signal?.aborted) throw new AbortedError();
        // With eager input streaming the SDK raises a plain AnthropicError when a tool input is
        // not parseable JSON. That (and only that) is worth re-issuing; API errors are mapped.
        if (error instanceof Anthropic.APIError) throw mapApiError(error);
        if (error instanceof Anthropic.AnthropicError && attempt < MAX_INVALID_JSON_RETRIES) {
          onEvent({ type: 'notice', message: t('Model produced malformed tool input; retrying the turn.') });
          continue;
        }
        throw error instanceof Error ? new ProviderError(error.message, 'other') : error;
      }
    }
  }

  private buildParams(request: ChatRequest): MessageCreateParamsStreaming {
    const adaptive = supportsAdaptiveThinking(this.model);
    const fallback = this.options.refusalFallback !== false && supportsDefaultFallback(this.model);
    return {
      model: this.model,
      max_tokens: this.options.maxTokens ?? 64000,
      system: [{ type: 'text', text: request.system }],
      messages: toClaudeMessages(request.messages),
      ...(request.tools.length ? { tools: request.tools.map(toClaudeTool) } : {}),
      // Top-level auto-caching: the stable system prompt + tools + append-only history are
      // re-read from cache on every turn of the agent loop.
      cache_control: { type: 'ephemeral' },
      ...(adaptive
        ? {
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: this.options.effort ?? 'medium' },
          }
        : {}),
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
      stream: true,
    };
  }

  private async streamOnce(
    params: MessageCreateParamsStreaming,
    signal: AbortSignal | undefined,
    onEvent: (event: ProviderStreamEvent) => void,
  ): Promise<ChatResponse> {
    const stream = this.client.beta.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') onEvent({ type: 'tool_call_start', id: block.id, name: block.name });
        if (block.type === 'fallback') {
          onEvent({ type: 'notice', message: t('{from} declined; continuing on {to}.', { from: block.from.model, to: block.to.model }) });
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') onEvent({ type: 'text_delta', text: event.delta.text });
        else if (event.delta.type === 'thinking_delta') onEvent({ type: 'reasoning_delta', text: event.delta.thinking });
      }
    }
    const final = await stream.finalMessage();
    return fromClaudeMessage(final);
  }
}

function toClaudeTool(tool: ToolSpec): BetaTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as BetaTool['input_schema'],
    // Stream large inputs (file bodies) as they are generated; the orchestrator validates
    // every parsed input against the schema before running the tool.
    eager_input_streaming: true,
  };
}

export function toClaudeMessages(messages: ChatMessage[]): BetaMessageParam[] {
  return messages.map((message): BetaMessageParam => {
    if (message.role === 'assistant') {
      if (message.native?.provider === PROVIDER_ID) {
        // Replay verbatim: thinking blocks must come back unmodified. An empty turn (e.g. a
        // refusal before any output) would be rejected, so it gets a placeholder instead.
        const native = message.native.content as BetaContentBlockParam[];
        return { role: 'assistant', content: native.length ? native : [{ type: 'text', text: '(no content)' }] };
      }
      const content: BetaContentBlockParam[] = [];
      for (const block of message.content) {
        if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_call') {
          content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        }
      }
      if (content.length === 0) content.push({ type: 'text', text: '(no content)' });
      return { role: 'assistant', content };
    }
    const content: BetaContentBlockParam[] = message.content.map((block): BetaContentBlockParam => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'image') return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } };
      const text = block.content || '(empty)';
      return {
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: block.images?.length
          ? [
              { type: 'text', text },
              ...block.images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
            ]
          : text,
        ...(block.isError ? { is_error: true } : {}),
      };
    });
    return { role: 'user', content };
  });
}

function fromClaudeMessage(message: BetaMessage): ChatResponse {
  const content: AssistantMessage['content'] = [];
  for (const block of message.content as BetaContentBlock[]) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text });
    else if (block.type === 'thinking' && block.thinking) content.push({ type: 'reasoning', text: block.thinking });
    else if (block.type === 'tool_use') {
      const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
      content.push({ type: 'tool_call', id: block.id, name: block.name, input });
    }
  }
  const usage: Usage = {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
  let stopDetail: string | undefined;
  if (message.stop_reason === 'refusal') {
    const details = message.stop_details;
    stopDetail = details ? [details.category, details.explanation].filter(Boolean).join(': ') : undefined;
  }
  return {
    message: { role: 'assistant', content, native: { provider: PROVIDER_ID, content: message.content } },
    stopReason: mapStopReason(message.stop_reason),
    stopDetail,
    usage,
    model: message.model,
  };
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause';
    default:
      return 'other';
  }
}

function mapApiError(error: InstanceType<typeof Anthropic.APIError>): ProviderError {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(`Claude rejected the API key (${error.status}). ${error.message}`, 'auth', error.status);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError(`Claude rate limit reached. ${error.message}`, 'rate_limit', error.status);
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    return new ProviderError(`Claude rejected the request: ${error.message}`, 'bad_request', error.status);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Could not reach the Claude API: ${error.message}`, 'network');
  }
  return new ProviderError(`Claude API error: ${error.message}`, 'server', error.status);
}
