/**
 * A front-end neutral view model of the agent session, built by folding AgentEvents.
 * Pure TypeScript with type-only imports, so it runs in the extension host, in a webview and in
 * a future desktop renderer alike.
 */
import type { FileChange } from '../changes/ChangeTracker';
import type { AgentEvent, AgentPhase, AgentUsage, CompactionView, NoticeLevel, SupervisorScope, SupervisorStatus, ToolCallView } from '../orchestrator/events';
import type { Plan } from '../planning/Plan';
import type { Usage } from '../types';

export interface SubagentView {
  agent: string;
  model?: string;
  running: boolean;
  phase: AgentPhase;
  items: TranscriptItem[];
  /** Tokens this sub-agent run has used so far. */
  usage?: Usage;
}

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; attachments?: string[]; skills?: string[]; images?: Array<{ name: string; thumb?: string }> }
  | { kind: 'assistant'; id: string; text: string; reasoning: string; streaming: boolean; model?: string }
  | { kind: 'tool'; id: string; call: ToolCallView; liveOutput: string; sub?: SubagentView }
  | { kind: 'notice'; id: string; level: NoticeLevel; message: string; action?: string }
  | { kind: 'supervisor'; id: string; scope: SupervisorScope; status: SupervisorStatus; message?: string; model?: string; reason?: string }
  | ({ kind: 'compaction' } & CompactionView);

export interface SessionView {
  items: TranscriptItem[];
  running: boolean;
  phase: AgentPhase;
  plan?: Plan;
  changes: FileChange[];
  usage?: Usage;
  model?: string;
  /** Per-agent breakdown of `usage` (main, supervisor, sub-agents). */
  usageByAgent?: AgentUsage[];
}

const MAX_LIVE_OUTPUT = 20_000;

export function emptySession(): SessionView {
  return { items: [], running: false, phase: 'idle', changes: [] };
}

/** Apply one event in place. Returns the id of the item that changed (for incremental rendering). */
export function applyEvent(state: SessionView, event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'reset':
      state.items = [];
      state.plan = undefined;
      state.usage = undefined;
      state.usageByAgent = undefined;
      return undefined;
    case 'run_started':
      state.running = true;
      return undefined;
    case 'run_finished':
      state.running = false;
      for (const item of state.items) if (item.kind === 'assistant') item.streaming = false;
      // Drop assistant bubbles that ended up empty (turns that only called tools).
      state.items = state.items.filter((i) => !(i.kind === 'assistant' && !i.text.trim() && !i.reasoning.trim()));
      return undefined;
    case 'phase':
      state.phase = event.phase;
      return undefined;
    case 'plan':
      state.plan = event.plan;
      return undefined;
    case 'changes':
      state.changes = event.changes;
      return undefined;
    case 'usage':
      state.usage = event.total;
      if (event.model) state.model = event.model;
      if (event.byAgent) state.usageByAgent = event.byAgent;
      return undefined;
    case 'user_message':
      state.items.push({ kind: 'user', id: event.id, text: event.text, attachments: event.attachments, skills: event.skills, images: event.images });
      return event.id;
    case 'rewound': {
      const index = state.items.findIndex((i) => i.kind === 'user' && i.id === event.id);
      if (index !== -1) state.items = state.items.slice(0, index);
      return undefined;
    }
    case 'assistant_start':
      state.items.push({ kind: 'assistant', id: event.id, text: '', reasoning: '', streaming: true });
      return event.id;
    case 'assistant_delta': {
      const item = find(state, event.id, 'assistant');
      if (item) item.text += event.text;
      return event.id;
    }
    case 'reasoning_delta': {
      const item = find(state, event.id, 'assistant');
      if (item) item.reasoning += event.text;
      return event.id;
    }
    case 'assistant_end': {
      const item = find(state, event.id, 'assistant');
      if (item) {
        item.text = event.text || item.text;
        item.streaming = false;
        item.model = event.model;
      }
      return event.id;
    }
    case 'tool_call': {
      const existing = find(state, event.call.id, 'tool');
      if (existing) existing.call = { ...existing.call, ...event.call };
      else state.items.push({ kind: 'tool', id: event.call.id, call: event.call, liveOutput: '' });
      return event.call.id;
    }
    case 'tool_output': {
      const item = find(state, event.id, 'tool');
      if (item) {
        item.liveOutput += event.chunk;
        if (item.liveOutput.length > MAX_LIVE_OUTPUT) item.liveOutput = item.liveOutput.slice(-MAX_LIVE_OUTPUT);
      }
      return event.id;
    }
    case 'notice': {
      const id = `n${state.items.length}_${Date.now().toString(36)}`;
      state.items.push({ kind: 'notice', id, level: event.level, message: event.message, action: event.action });
      return id;
    }
    case 'supervisor': {
      const existing = find(state, event.id, 'supervisor');
      const { type: _type, ...fields } = event;
      if (existing) Object.assign(existing, fields);
      else state.items.push({ kind: 'supervisor', ...fields });
      return event.id;
    }
    case 'compaction': {
      const existing = find(state, event.id, 'compaction');
      const { type: _type, ...fields } = event;
      if (existing) Object.assign(existing, fields);
      else state.items.push({ kind: 'compaction', ...fields });
      return event.id;
    }
    case 'subagent': {
      // Fold the sub-agent's events into a nested view on the run_subagent tool item.
      const parent = findDeep(state.items, event.parentId);
      if (!parent) return undefined;
      const sub = (parent.sub ??= { agent: event.agent, running: true, phase: 'thinking', items: [] });
      const inner: SessionView = { items: sub.items, running: sub.running, phase: sub.phase, changes: [] };
      applyEvent(inner, event.event);
      sub.items = inner.items;
      sub.running = inner.running;
      sub.phase = inner.phase;
      if (inner.model) sub.model = inner.model;
      if (inner.usage) sub.usage = inner.usage;
      return topLevelId(state, parent.id);
    }
  }
}

/**
 * A copy of the session small enough to store with a task: long tool outputs, details and live
 * output are cut down (the model's own history keeps the full results).
 */
export function slimSession(state: SessionView, maxChars = 4_000): SessionView {
  const cut = (text: string | undefined) => (text && text.length > maxChars ? `${text.slice(0, maxChars / 2)}\n…\n${text.slice(-maxChars / 2)}` : text);
  const slimItems = (items: TranscriptItem[]): TranscriptItem[] =>
    items.map((item) => {
      if (item.kind !== 'tool') return item;
      return {
        ...item,
        liveOutput: '',
        call: { ...item.call, output: cut(item.call.output ?? (item.liveOutput || undefined)), detail: cut(item.call.detail) },
        sub: item.sub ? { ...item.sub, running: false, items: slimItems(item.sub.items) } : undefined,
      };
    });
  return { ...state, running: false, phase: 'idle', items: slimItems(state.items) };
}

/** Find a tool item at any nesting depth. */
function findDeep(items: TranscriptItem[], id: string): Extract<TranscriptItem, { kind: 'tool' }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== 'tool') continue;
    if (item.id === id) return item;
    const nested = item.sub && findDeep(item.sub.items, id);
    if (nested) return nested;
  }
  return undefined;
}

/** The id of the top-level item that contains `id` (the unit the UI re-renders). */
function topLevelId(state: SessionView, id: string): string {
  for (const item of state.items) {
    if (item.id === id) return item.id;
    if (item.kind === 'tool' && item.sub && findDeep(item.sub.items, id)) return item.id;
  }
  return id;
}

function find<K extends TranscriptItem['kind']>(state: SessionView, id: string, kind: K): Extract<TranscriptItem, { kind: K }> | undefined {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.id === id && item.kind === kind) return item as Extract<TranscriptItem, { kind: K }>;
  }
  return undefined;
}
