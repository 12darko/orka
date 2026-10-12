import { ApiError, type Content, type FunctionDeclaration, GoogleGenAI, type Part, ThinkingLevel } from '@google/genai';
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

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  thinkingLevel?: 'low' | 'medium' | 'high';
  baseURL?: string;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

const PROVIDER_ID = 'gemini';
/** Prefix for call ids we had to invent because the API returned none. */
const SYNTHETIC_ID = 'gemini-noid-';
/**
 * Placeholder signature for function calls that Gemini did not produce itself (history carried
 * over from another provider); Gemini 3 otherwise rejects unsigned calls in the current turn.
 */
const FOREIGN_CALL_SIGNATURE = 'skip_thought_signature_validator';

export class GeminiProvider implements AIProvider {
  readonly id = PROVIDER_ID;
  readonly label = 'Gemini';
  readonly model: string;
  private readonly client: GoogleGenAI;
  private idCounter = 0;

  constructor(private readonly options: GeminiProviderOptions) {
    this.model = options.model || DEFAULT_GEMINI_MODEL;
    this.client = new GoogleGenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { httpOptions: { baseUrl: options.baseURL } } : {}),
    });
  }

  async chat(request: ChatRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<ChatResponse> {
    const parts: Part[] = [];
    const content: AssistantMessage['content'] = [];
    let text = '';
    let reasoning = '';
    let finishReason: string | undefined;
    let blockReason: string | undefined;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let servedModel = this.model;

    try {
      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents: toGeminiContents(request.messages),
        config: {
          systemInstruction: request.system,
          ...(request.tools.length ? { tools: [{ functionDeclarations: request.tools.map(toDeclaration) }] } : {}),
          thinkingConfig: {
            includeThoughts: true,
            ...(this.options.thinkingLevel ? { thinkingLevel: LEVELS[this.options.thinkingLevel] } : {}),
          },
          abortSignal: request.signal,
        },
      });
      for await (const chunk of stream) {
        if (chunk.modelVersion) servedModel = chunk.modelVersion;
        if (chunk.promptFeedback?.blockReason) blockReason = String(chunk.promptFeedback.blockReason);
        if (chunk.usageMetadata) {
          const m = chunk.usageMetadata;
          const cached = m.cachedContentTokenCount ?? 0;
          usage = {
            inputTokens: Math.max(0, (m.promptTokenCount ?? 0) - cached),
            outputTokens: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0),
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
          };
        }
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) finishReason = String(candidate.finishReason);
        for (const part of candidate?.content?.parts ?? []) {
          // Keep every part exactly as received: thought signatures ride on them.
          parts.push(part);
          if (part.thought) {
            if (part.text) {
              reasoning += part.text;
              onEvent({ type: 'reasoning_delta', text: part.text });
            }
          } else if (part.text) {
            text += part.text;
            onEvent({ type: 'text_delta', text: part.text });
          }
          if (part.functionCall) {
            const id = part.functionCall.id || `${SYNTHETIC_ID}${Date.now().toString(36)}${this.idCounter++}`;
            const name = part.functionCall.name ?? '';
            onEvent({ type: 'tool_call_start', id, name });
            content.push({ type: 'tool_call', id, name, input: (part.functionCall.args as Record<string, unknown>) ?? {} });
          }
        }
      }
    } catch (error) {
      if (request.signal?.aborted) throw new AbortedError();
      throw mapError(error);
    }

    if (text) content.unshift({ type: 'text', text });
    if (reasoning.trim()) content.unshift({ type: 'reasoning', text: reasoning });
    const hasCalls = content.some((b) => b.type === 'tool_call');
    return {
      message: { role: 'assistant', content, native: { provider: PROVIDER_ID, content: parts } },
      stopReason: hasCalls ? 'tool_use' : mapFinishReason(finishReason, blockReason),
      stopDetail: blockReason ?? (finishReason && finishReason !== 'STOP' ? finishReason : undefined),
      usage,
      model: servedModel,
    };
  }
}

const LEVELS = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH } as const;

function toDeclaration(tool: ToolSpec): FunctionDeclaration {
  return { name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema };
}

export function toGeminiContents(messages: readonly ChatMessage[]): Content[] {
  const callNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool_call') callNames.set(b.id, b.name);
  }
  const contents: Content[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (message.native?.provider === PROVIDER_ID && Array.isArray(message.native.content) && message.native.content.length) {
        contents.push({ role: 'model', parts: message.native.content as Part[] });
        continue;
      }
      const parts: Part[] = [];
      let signed = false;
      for (const block of message.content) {
        if (block.type === 'text' && block.text) parts.push({ text: block.text });
        else if (block.type === 'tool_call') {
          parts.push({
            functionCall: { name: block.name, args: block.input, ...(isSynthetic(block.id) ? {} : { id: block.id }) },
            ...(signed ? {} : { thoughtSignature: FOREIGN_CALL_SIGNATURE }),
          });
          signed = true;
        }
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '(no content)' }] });
      continue;
    }
    const parts: Part[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        parts.push({
          functionResponse: {
            name: callNames.get(block.toolCallId) ?? 'tool',
            ...(isSynthetic(block.toolCallId) ? {} : { id: block.toolCallId }),
            response: block.isError ? { error: block.content } : { output: block.content },
          },
        });
        for (const image of block.images ?? []) parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
      } else if (block.type === 'image') {
        parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } });
      } else if (block.text) {
        parts.push({ text: block.text });
      }
    }
    contents.push({ role: 'user', parts: parts.length ? parts : [{ text: '(empty)' }] });
  }
  return contents;
}

function isSynthetic(id: string): boolean {
  return id.startsWith(SYNTHETIC_ID);
}

function mapFinishReason(reason: string | undefined, blockReason: string | undefined): StopReason {
  if (blockReason) return 'refusal';
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
    case 'RECITATION':
    case 'IMAGE_SAFETY':
      return 'refusal';
    case undefined:
    case 'STOP':
    case 'FINISH_REASON_UNSPECIFIED':
      return 'end_turn';
    default:
      return 'other';
  }
}

function mapError(error: unknown): Error {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return new ProviderError(`Gemini rejected the API key (${error.status}). ${error.message}`, 'auth', error.status);
    if (error.status === 429) return new ProviderError(`Gemini rate limit reached. ${error.message}`, 'rate_limit', error.status);
    if (error.status >= 400 && error.status < 500) return new ProviderError(`Gemini rejected the request: ${error.message}`, 'bad_request', error.status);
    return new ProviderError(`Gemini API error: ${error.message}`, 'server', error.status);
  }
  if (error instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(error.message)) {
    return new ProviderError(`Could not reach the Gemini API: ${error.message}`, 'network');
  }
  return error instanceof Error ? error : new Error(String(error));
}
