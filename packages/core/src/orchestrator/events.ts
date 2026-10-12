import type { FileChange } from '../changes/ChangeTracker';
import type { PermissionCategory, RiskLevel } from '../permissions/PermissionManager';
import type { Plan } from '../planning/Plan';
import type { Usage } from '../types';

/** Coarse stage of the agent loop, derived from what the agent is doing right now. */
export type AgentPhase = 'idle' | 'thinking' | 'analyzing' | 'planning' | 'implementing' | 'verifying' | 'delegating';

export type ToolCallStatus = 'awaiting_approval' | 'running' | 'done' | 'error' | 'denied' | 'cancelled';

export interface ToolCallView {
  id: string;
  name: string;
  title: string;
  category: PermissionCategory;
  risk: RiskLevel;
  status: ToolCallStatus;
  detail?: string;
  /** Final (possibly truncated) result text. */
  output?: string;
  /** Proposed change available for a diff preview while awaiting approval. */
  hasPreview?: boolean;
  /** Absolute path of the file the tool changed/reads, if any (lets UIs link to it). */
  path?: string;
  /** A small preview image (data URL), e.g. of a browser screenshot. */
  image?: string;
}

/** Token use of one agent role ("main", "supervisor", or a sub-agent name) in the current task. */
export interface AgentUsage {
  agent: string;
  /** Provider id ("claude", "claude-code", "openai", "gemini", ...). */
  provider: string;
  model: string;
  calls: number;
  usage: Usage;
}

export type RunEndReason = 'completed' | 'stopped' | 'error' | 'max_iterations' | 'budget' | 'refusal';

export type NoticeLevel = 'info' | 'warning' | 'error';

export type AgentEvent =
  | { type: 'run_started' }
  | { type: 'run_finished'; reason: RunEndReason }
  | { type: 'user_message'; id: string; text: string; attachments?: string[]; skills?: string[]; images?: Array<{ name: string; thumb?: string }> }
  | { type: 'assistant_start'; id: string }
  | { type: 'assistant_delta'; id: string; text: string }
  | { type: 'reasoning_delta'; id: string; text: string }
  | { type: 'assistant_end'; id: string; text: string; model: string }
  | { type: 'tool_call'; call: ToolCallView }
  | { type: 'tool_output'; id: string; chunk: string }
  | { type: 'plan'; plan: Plan | undefined }
  | { type: 'changes'; changes: FileChange[] }
  | { type: 'phase'; phase: AgentPhase }
  | { type: 'usage'; total: Usage; model: string; byAgent?: AgentUsage[] }
  | { type: 'notice'; level: NoticeLevel; message: string; action?: string }
  | { type: 'reset' }
  /** An event from a sub-agent, nested under the run_subagent tool call that started it. */
  | { type: 'subagent'; parentId: string; agent: string; event: AgentEvent }
  /** A supervisor review of the main agent's work (updated in place by id). */
  | { type: 'supervisor'; id: string; scope: SupervisorScope; status: SupervisorStatus; message?: string; model?: string; reason?: string }
  /** The conversation was (or is being) compacted into a handoff note. */
  | ({ type: 'compaction' } & CompactionView);

export type SupervisorStatus = 'reviewing' | 'ok' | 'intervened' | 'error' | 'cancelled';

/** step: one step (step modes). plan / stuck / progress / final: checkpoints. */
export type SupervisorScope = 'step' | 'final' | 'plan' | 'stuck' | 'progress';

export interface CompactionView {
  id: string;
  status: 'running' | 'done' | 'error';
  reason: 'auto' | 'manual';
  beforeTokens?: number;
  afterTokens?: number;
  /** The model's handoff note. */
  summary?: string;
  message?: string;
}
