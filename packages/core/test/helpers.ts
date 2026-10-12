import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AIProvider, ChatRequest, ChatResponse, ProviderStreamEvent } from '../src/providers/AIProvider';
import type { AssistantMessage, ChatMessage } from '../src/types';

export function tempWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-orch-test-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type Step = (request: ChatRequest) => AssistantMessage['content'] | ChatResponse;

/** A provider that plays back a fixed script of assistant turns and records every request. */
export class ScriptedProvider implements AIProvider {
  readonly id = 'scripted';
  readonly label = 'Scripted';
  readonly model = 'scripted-model';
  readonly requests: Array<{ system: string; messages: ChatMessage[]; tools: string[] }> = [];
  private index = 0;

  constructor(private readonly steps: Step[]) {}

  async chat(request: ChatRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<ChatResponse> {
    // Snapshot the history as sent, to assert the conversation stays append-only.
    this.requests.push({
      system: request.system,
      messages: JSON.parse(JSON.stringify(request.messages)),
      tools: request.tools.map((t) => t.name),
    });
    const step = this.steps[this.index++];
    if (!step) throw new Error(`ScriptedProvider ran out of steps at request ${this.index}`);
    const out = step(request);
    if (!Array.isArray(out)) return out;
    for (const block of out) if (block.type === 'text') onEvent({ type: 'text_delta', text: block.text });
    const hasCalls = out.some((b) => b.type === 'tool_call');
    return {
      message: { role: 'assistant', content: out },
      stopReason: hasCalls ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: this.model,
    };
  }

  get remaining(): number {
    return this.steps.length - this.index;
  }
}

let callId = 0;
export function call(name: string, input: Record<string, unknown>) {
  return { type: 'tool_call' as const, id: `call_${++callId}`, name, input };
}

export function text(value: string) {
  return { type: 'text' as const, text: value };
}

/** The tool results the model received in its latest request. */
export function lastToolResults(request: ChatRequest) {
  const last = request.messages[request.messages.length - 1];
  return last.role === 'user' ? last.content.filter((b) => b.type === 'tool_result') : [];
}
