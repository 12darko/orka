import type { AIProvider } from '../providers/AIProvider';
import { addUsage, type AssistantMessage, type ChatMessage, emptyUsage, messageText, type ToolResultBlock, type Usage } from '../types';

/**
 * checkpoints (default): the supervisor is only involved at decisive moments - a new plan, the
 * agent getting stuck, a long stretch without progress, the agent asking for help, the final
 * result. every_turn / on_changes: it also reviews individual steps (thorough, token-heavy).
 * final_only: just the final review.
 */
export type SupervisorFrequency = 'checkpoints' | 'every_turn' | 'on_changes' | 'final_only';

/** Why a checkpoint review runs. */
export type CheckpointKind = 'plan' | 'stuck' | 'progress' | 'final';

export interface SupervisorSettings {
  enabled: boolean;
  /** When the supervisor looks at the agent's work; a final review always runs when the agent says it is done. */
  frequency: SupervisorFrequency;
  /** Stop intervening after this many corrections in one run, to avoid ping-pong; also caps the agent's questions. */
  maxInterventions: number;
  /**
   * Step reviews only (every_turn / on_changes). "parallel" (default): the agent keeps working
   * while a step is reviewed; a correction arrives with the following step. "blocking": the agent
   * waits for each review before its next step. Checkpoint reviews always wait.
   */
  mode?: 'parallel' | 'blocking';
}

export interface SupervisorReview {
  verdict: 'ok' | 'intervene';
  message: string;
  model: string;
  /** Provider id and tokens of this review call. */
  provider: string;
  usage: Usage;
}

export interface SupervisorAdvice {
  advice: string;
  model: string;
  provider: string;
  usage: Usage;
}

const MAX_TEXT = 1_500;
const MAX_VALUE = 600;
const MAX_RESULT = 900;
/** Project context sent with each stateless checkpoint (the file tree is the bulk of it). */
const MAX_PROJECT_CONTEXT = 3_000;

const CHECKPOINT_HEADER: Record<CheckpointKind, string> = {
  plan: 'PLAN CHECKPOINT - the agent has proposed a plan and not implemented it yet. Check that the plan does what the user asked, in a sound way, before the work starts.',
  stuck: 'STUCK CHECKPOINT - the agent seems to be stuck. Find the real cause and tell it how to get unstuck.',
  progress: 'PROGRESS CHECKPOINT - the agent has worked for a while without visible progress. Check that it is still on track toward what the user asked.',
  final: 'FINAL REVIEW - the agent says it is done. Decide whether the task is really complete and correct.',
};

/**
 * An overseer model that watches the main agent and steps in when it goes wrong: misreading the
 * request, choosing the wrong architecture, breaking existing behavior, ignoring errors, claiming
 * success without evidence, looping. It has no tools and never does the work itself; its
 * corrections are sent to the main agent and shown to the user.
 *
 * Step reviews keep an append-only conversation per task. Checkpoint reviews and the agent's
 * questions are stateless: each gets one compact brief (the user's requests, plan, diff, recent
 * activity, earlier corrections) built by the orchestrator, so their cost does not grow with the
 * length of the task.
 */
export class Supervisor {
  private messages: ChatMessage[] = [];
  private usage: Usage = emptyUsage();
  private pendingContext: string[] = [];

  constructor(
    private readonly getProvider: () => AIProvider,
    private readonly projectContext: () => string,
  ) {}

  get totalUsage(): Usage {
    return this.usage;
  }

  reset(): void {
    this.messages = [];
    this.usage = emptyUsage();
    this.pendingContext = [];
  }

  /** Something the supervisor should know with the next step review (e.g. a new user request). */
  note(text: string): void {
    this.pendingContext.push(text);
  }

  /** Review one step (or the end) as part of an ongoing conversation. */
  async review(kind: 'step' | 'final', activity: string, signal?: AbortSignal): Promise<SupervisorReview> {
    const provider = this.getProvider();
    const header = kind === 'final' ? CHECKPOINT_HEADER.final : 'STEP REVIEW - the agent is still working. Check this step.';
    const context = this.pendingContext.length ? `${this.pendingContext.join('\n\n')}\n\n` : '';
    this.pendingContext = [];
    const first = this.messages.length === 0 ? `# Project\n${this.projectContext()}\n\n` : '';
    this.messages.push({ role: 'user', content: [{ type: 'text', text: `${first}${context}# ${header}\n\n${activity}` }] });
    const response = await provider.chat({ system: SUPERVISOR_PROMPT, messages: this.messages, tools: [], signal }, () => {});
    this.messages.push(response.message);
    this.usage = addUsage(this.usage, response.usage);
    return { ...parseReview(messageText(response.message)), model: response.model || provider.model, provider: provider.id, usage: response.usage };
  }

  /** A stateless checkpoint review of a compact brief. */
  async check(kind: CheckpointKind, brief: string, signal?: AbortSignal): Promise<SupervisorReview> {
    const provider = this.getProvider();
    const text = `# Project (summary)\n${clip(this.projectContext(), MAX_PROJECT_CONTEXT)}\n\n# ${CHECKPOINT_HEADER[kind]}\n\n${brief}`;
    const response = await provider.chat({ system: SUPERVISOR_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [], signal }, () => {});
    this.usage = addUsage(this.usage, response.usage);
    return { ...parseReview(messageText(response.message)), model: response.model || provider.model, provider: provider.id, usage: response.usage };
  }

  /** The agent asks for guidance; the answer is advice, never the work itself. */
  async consult(question: string, brief: string, signal?: AbortSignal): Promise<SupervisorAdvice> {
    const provider = this.getProvider();
    const text = `# Project (summary)\n${clip(this.projectContext(), MAX_PROJECT_CONTEXT)}\n\n${brief}\n\n# The agent's question\n${question}`;
    const response = await provider.chat({ system: CONSULT_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [], signal }, () => {});
    this.usage = addUsage(this.usage, response.usage);
    const advice = messageText(response.message).trim() || '(no advice)';
    return { advice, model: response.model || provider.model, provider: provider.id, usage: response.usage };
  }
}

export function parseReview(reply: string): Pick<SupervisorReview, 'verdict' | 'message'> {
  const verdict = /<verdict>\s*(ok|intervene)\s*<\/verdict>/i.exec(reply)?.[1]?.toLowerCase();
  const message = /<message>([\s\S]*?)(<\/message>|$)/i.exec(reply)?.[1]?.trim();
  if (verdict === 'intervene' && message) return { verdict: 'intervene', message };
  if (verdict === 'intervene') {
    // indexOf rather than a lazy regex: linear even on a reply full of unclosed <verdict> tags.
    const lower = reply.toLowerCase();
    const start = lower.indexOf('<verdict>');
    const end = start === -1 ? -1 : lower.indexOf('</verdict>', start);
    const rest = (end === -1 ? reply : reply.slice(0, start) + reply.slice(end + '</verdict>'.length)).trim();
    if (rest) return { verdict: 'intervene', message: rest };
  }
  return { verdict: 'ok', message: message ?? '' };
}

/** A compact, supervisor-readable account of one main-agent turn and its tool results. */
export function describeTurn(assistant: AssistantMessage, results: readonly ToolResultBlock[] = []): string {
  const lines: string[] = [];
  const text = messageText(assistant).trim();
  if (text) lines.push(`Agent wrote:\n${clip(text, MAX_TEXT)}`);
  const byId = new Map(results.map((r) => [r.toolCallId, r]));
  for (const block of assistant.content) {
    if (block.type !== 'tool_call') continue;
    const args = Object.entries(block.input)
      .map(([k, v]) => `${k}=${clip(typeof v === 'string' ? v : JSON.stringify(v), k === 'content' || k === 'new_string' || k === 'task' ? MAX_VALUE : 200)}`)
      .join(', ');
    lines.push(`Tool call: ${block.name}(${args})`);
    const result = byId.get(block.id);
    if (result) lines.push(`${result.isError ? 'Result (ERROR)' : 'Result'}: ${clip(result.content, MAX_RESULT)}`);
  }
  return lines.join('\n') || '(the agent produced no output this turn)';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

/** How a correction is shown to the main agent. */
export function interventionText(review: SupervisorReview): string {
  return `[Supervisor] ${review.message}\n\n(This guidance comes from the supervising model overseeing your work. Take it seriously: follow it, or explain briefly why it does not apply.)`;
}

const SUPERVISOR_PROMPT = `You are the supervisor of an AI coding agent that works directly in a user's project. You are brought in at important moments - when the agent proposes a plan, when it seems stuck, when it has made no progress for a while, and when it says it is done - to compare what it is doing with what the user asked and to catch logical problems. You have no tools and never do the work yourself; the agent reads your guidance, and the user sees it too.

Intervene when a correction materially changes the outcome, for example:
- the agent misunderstood or drifted away from what the user asked, or skipped part of it;
- a logical error in the approach: wrong assumptions, a plan that cannot work, steps in the wrong order, an edge case that breaks the result;
- a wrong approach or architecture (fighting the existing design, reinventing what the project already has, a fragile or insecure design);
- breaking existing behavior, editing unrelated code, deleting things that should stay;
- ignoring errors or failing tests, or claiming success without evidence;
- going in circles, repeating the same failing action - name the real cause;
- risky actions the user did not ask for.
Do not intervene for style preferences, minor wording, or choices that are reasonable even if you would do it differently.

When you intervene, write to the agent directly: what is wrong, why it matters, and what to do instead, specifically (files, functions, commands). Keep it short. Write in the same language as the user's request.

Reply in exactly this format:
<verdict>ok</verdict>
or
<verdict>intervene</verdict>
<message>your guidance to the agent</message>`;

const CONSULT_PROMPT = `You are the supervisor of an AI coding agent that works directly in a user's project. The agent is asking you for guidance because it is stuck or unsure. You have no tools and do not do the work yourself.

Answer the agent's question directly with concrete, actionable guidance: the likely root cause, which approach to take and why, the files, functions or commands to look at. Do not write the whole implementation. If the question shows that the agent misunderstood the user's request or is working on the wrong problem, say that first. Keep it short. Write in the same language as the user's request. Reply in plain text.`;
