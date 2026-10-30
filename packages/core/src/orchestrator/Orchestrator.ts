import * as path from 'node:path';
import { DEFAULT_SUBAGENTS, READONLY_TOOLS, type SubagentProfile } from '../agents/subagents';
import type { TaskSnapshot } from '../persistence/TaskStore';
import { ChangeTracker } from '../changes/ChangeTracker';
import type { CommandChange, ShadowGit } from '../changes/ShadowGit';
import { mergeCopy, WorkspaceCopy } from '../changes/WorkspaceCopy';
import { ContextBuilder, type EditorContext } from '../context/ContextBuilder';
import { t } from '../i18n';
import { createSkillTool, invokedSkillBlock, type Skill } from '../skills/Skills';
import {
  type CheckpointKind,
  describeTurn,
  interventionText,
  Supervisor,
  type SupervisorReview,
  type SupervisorSettings,
} from '../supervisor/Supervisor';
import type { Host } from '../host/Host';
import type { PermissionManager } from '../permissions/PermissionManager';
import { formatPlan, type Plan } from '../planning/Plan';
import { AbortedError, type AIProvider, type ChatResponse, isAbortError, ProviderError, type ProviderStreamEvent } from '../providers/AIProvider';
import { INVALID_JSON_KEY } from '../providers/OpenAIProvider';
import { defaultTools } from '../tools';
import { type Tool, type ToolAction, type ToolContext, ToolError, toSpec, truncateMiddle, validateInput } from '../tools/Tool';
import {
  addUsage,
  type ChatMessage,
  emptyUsage,
  type ImageBlock,
  messageText,
  type ToolCallBlock,
  type ToolResultBlock,
  type Usage,
} from '../types';
import type { AgentEvent, AgentPhase, AgentUsage, RunEndReason, ToolCallView } from './events';
import { Handoff, handoffBrief, recordChangesSince, userRequests } from '../handoff/Handoff';
import type { AcpClient } from '../acp/AcpClient';
import { AcpAgentSession, type AcpSessionContext, type AcpTurnResult } from '../acp/AcpAgentSession';
import type { ExternalAgentRuntime } from '../acp/pool';
import { ACP_AUTH_REQUIRED, type ContentBlock } from '../acp/types';
import { SECRET_FILE, secretInCommand } from '../permissions/secrets';
import { JsonRpcError } from '../rpc/JsonRpcStdio';
import { appendLessons, LESSONS_FILE, MEMORY_DIR, parseLessons } from '../memory/ProjectMemory';
import { describeHookResult, type HookCommand, type HookResult, hooksForFile, type HooksConfig, runHook } from '../hooks/Hooks';
import { toRelative } from '../tools/workspace';
import { isSimpleRequest } from './routing';

export interface OrchestratorSettings {
  /** Model turns per user request before pausing for the user. */
  maxIterations: number;
  /** Ask the model to verify (build/test) when it changed code but never ran anything after. */
  autoVerify: boolean;
  commandTimeoutMs: number;
  customInstructions?: string;
  /** How many read-only sub-agents may run at the same time (1 = one after another). Default 3. */
  maxParallelSubagents?: number;
  /** Replace a long conversation with a handoff note once a request's prompt exceeds the threshold. */
  compaction?: { auto: boolean; thresholdTokens: number };
  /**
   * Pause a request once it has used this many new tokens (input + output + cache writes of every
   * agent; cache reads are not counted). 0 or undefined: no limit.
   */
  tokenBudget?: number;
  /** The user's commands to run after edits and before the agent finishes (formatters, linters, tests). */
  hooks?: HooksConfig;
  /**
   * After a request that changed code, keep a few durable lessons in `.project-ai/lessons.md`
   * (only in projects that have a `.project-ai/` folder). Default: on.
   */
  learnLessons?: boolean;
  /**
   * Workers the agent starts together run side by side, each in its own copy of the workspace,
   * and their changes are merged afterwards (needs command snapshots). Default: on; off runs them
   * one after another in the workspace.
   */
  parallelWorkers?: boolean;
}

/** An image the user attached to a request (e.g. a pasted screenshot). */
export interface AttachedImage {
  name: string;
  mediaType: ImageBlock['mediaType'];
  /** Base64 data, sent to the model. */
  data: string;
  /** Small data URL for the chat view (not sent to the model). */
  thumb?: string;
}

export interface SubagentSupport {
  /** Profiles available to the main agent; read once per task (the tool list is frozen per task). */
  getProfiles(): SubagentProfile[];
  /** Provider for a sub-agent; may differ from the main agent's (e.g. Gemini for explore). */
  getProvider(name: string): AIProvider;
}

export interface OrchestratorOptions {
  host: Host;
  /** Called at the start of every model turn, so provider/model changes apply immediately. */
  getProvider: () => AIProvider;
  permissions: PermissionManager;
  getSettings: () => OrchestratorSettings;
  tools?: Tool[];
  /** Enables the run_subagent tool. */
  subagents?: SubagentSupport;
  /** Share a change tracker (sub-agents write into their parent's change list). */
  changes?: ChangeTracker;
  /** Run as this sub-agent (different system prompt) instead of as the main agent. */
  role?: SubagentProfile;
  /** An overseer model that reviews the main agent's steps and corrects it. */
  supervisor?: {
    getProvider(): AIProvider;
    getSettings(): SupervisorSettings;
  };
  /** Skills the agent may load; read once per task (frozen with the system prompt). */
  skills?: () => readonly Skill[];
  /**
   * A provider to continue on when the agent's own hits a usage/rate limit or is unavailable
   * (e.g. the Claude Code session limit). Used for the rest of that request.
   */
  getFallbackProvider?: () => AIProvider | undefined;
  /** A lighter model for short questions (answered without changes); the main model does everything else. */
  getLightProvider?: () => AIProvider | undefined;
  /** Snapshots around terminal commands, so the files they change can be reverted. */
  commandSnapshots?: ShadowGit;
  /** More tools for new tasks, e.g. from MCP servers; loaded when a task starts and frozen with it. */
  getExtraTools?: () => Promise<Tool[]>;
  /**
   * A third-party coding agent (Gemini CLI, Codex, ...) as the main agent, over ACP; read when a
   * request starts. While it returns a runtime, requests run in the agent's own loop and
   * getProvider is not called for the main agent. Work that needs a plain model is then skipped:
   * light-model routing, the fallback provider, compaction, learning lessons and the
   * ask_supervisor tool. The Supervisor keeps its own provider and reviews the final result.
   * Needs commandSnapshots: without them the agent does not start.
   */
  getExternalAgent?: () => ExternalAgentRuntime | undefined;
}

const MAX_TOOL_RESULT_CHARS = 40_000;
/** How much of the task's diff the supervisor sees in its final review. */
const FINAL_REVIEW_DIFF_CHARS = 16_000;
const NON_CODE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.rst']);
const SUBAGENT_TOOL = 'run_subagent';
const SUPERVISOR_TOOL = 'ask_supervisor';
/** Tools that change nothing the supervisor needs to review (showing things, asking for advice). */
const SHOW_TOOLS = new Set(['open_file', 'open_browser', SUPERVISOR_TOOL]);
/** Checkpoint mode: steps without visible progress (no code change, no plan step done) before a progress check. */
const PROGRESS_STEPS = 12;
/** Tool activity lines kept for the supervisor's briefs. */
const ACTIVITY_LINES = 12;
/** beforeFinish hooks that keep failing send the agent back at most this many times per request. */
const MAX_HOOK_ROUNDS = 3;

/** Where the task stood just before a user message, to go back there. */
interface RewindPoint {
  /** The user message's id (as in its user_message event). */
  id: string;
  text: string;
  messageIndex: number;
  /** The change tracker's epoch, for restoring files. */
  epoch: number;
  plan?: Plan;
  requests: number;
  corrections: number;
}

/** What one request has done so far (verify nudge, project checks, lessons). */
interface RequestState {
  codeChangedSinceCheck: boolean;
  verifyNudged: boolean;
  changedSinceHooks: boolean;
  hookRounds: number;
  changedCode: boolean;
}

/** Per-request supervisor state. */
interface Watch {
  active: boolean;
  /** Checkpoint mode: reviews only at plan / stuck / no-progress / final, from compact briefs. */
  checkpoints: boolean;
  interventions: number;
  consultations: number;
  pending?: Promise<SupervisorReview | undefined>;
  planChecks: number;
  stepsSinceProgress: number;
  /** Recent tool outcomes, for stuck detection. */
  recent: Array<{ key: string; error: boolean }>;
}

/**
 * Runs the agent loop: UNDERSTAND -> ANALYZE -> PLAN -> EXECUTE -> CHECK -> TEST/BUILD ->
 * (error? REPLAN : COMPLETE). The model makes the decisions; the orchestrator owns the
 * conversation, executes tools, enforces permissions, tracks changes and plan, and pushes the
 * model to verify its work before it declares the task complete.
 *
 * The conversation is append-only: earlier turns are never edited, the system prompt and tool
 * list are frozen for the whole task. This keeps prompt caching effective and keeps replayed
 * reasoning blocks valid.
 */
export class Orchestrator {
  readonly changes: ChangeTracker;
  private readonly context: ContextBuilder;
  private readonly baseTools: Tool[];
  /** Tools of the current task, frozen when its system prompt is built. */
  private taskTools: Tool[] = [];
  private taskToolsByName = new Map<string, Tool>();
  private taskProfiles: SubagentProfile[] = [];
  private taskSkills: readonly Skill[] = [];
  private taskSupervised = false;
  /** Tools from getExtraTools (MCP), loaded once per task. */
  private extraTools: Tool[] = [];
  private extraLoaded = false;
  /** Supervisor state of the running request (read by the ask_supervisor tool). */
  private watch?: Watch;
  /** One line per recent tool call, for the supervisor's briefs. */
  private activity: string[] = [];
  /** A file that may hold secrets, read in this task: from then on web access always asks. */
  private secretFile?: string;
  /** Provider and model of the last main-agent turn, to notice a switch mid-task. */
  private lastProviderKey?: string;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly unsubscribeChanges?: () => void;
  private readonly supervisor?: Supervisor;
  private lastModel = '';
  /** Prompt size of the last main-agent request (input incl. cache), to decide on compaction. */
  private lastPromptTokens = 0;
  /** Verbatim user requests and supervisor corrections of this task, for compaction handoffs. */
  private userRequests: string[] = [];
  private corrections: string[] = [];
  /** Token use per agent role in this task: main, supervisor, each sub-agent. */
  private agentUsage = new Map<string, AgentUsage>();
  /** One per user request of this task (main agent only), oldest first. */
  private rewindPoints: RewindPoint[] = [];
  /** Workers of the running side-by-side batch, by tool call id: their copy and, once done, what they changed. */
  private isolated = new Map<string, { copy: WorkspaceCopy; changes?: CommandChange[] }>();
  /** The external agent's ACP session in this task; stale after a rewind (the next request opens a fresh one). */
  private acp?: { agentId: string; session: AcpAgentSession; stale: boolean };
  /** Notices shown once per task (what an external agent cannot do). */
  private shownNotices = new Set<string>();
  /**
   * Which task the orchestrator holds: a new task or another opened task counts it up. An external
   * agent's turn that ends after that belongs to no task and writes nothing (messages, changes, events).
   */
  private generation = 0;

  private messages: ChatMessage[] = [];
  private systemPrompt?: string;
  private plan?: Plan;
  private notes: string[] = [];
  private abort?: AbortController;
  private idCounter = 0;
  /** Message of the last error that ended a run (read by a parent agent). */
  lastError?: string;

  constructor(private readonly options: OrchestratorOptions) {
    this.baseTools = options.tools ?? defaultTools();
    this.changes = options.changes ?? new ChangeTracker(options.host);
    this.context = new ContextBuilder(options.host);
    // A shared tracker is published by its owner.
    if (!options.changes) this.unsubscribeChanges = this.changes.onDidChange(() => void this.publishChanges());
    if (options.supervisor && !options.role) {
      this.supervisor = new Supervisor(
        () => options.supervisor!.getProvider(),
        () => this.context.projectSummary,
      );
    }
  }

  dispose(): void {
    this.stop();
    this.generation++;
    this.dropAcpSession();
    this.unsubscribeChanges?.();
    this.listeners.clear();
  }

  on(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get isRunning(): boolean {
    return !!this.abort;
  }

  get currentPlan(): Plan | undefined {
    return this.plan;
  }

  get history(): readonly ChatMessage[] {
    return this.messages;
  }

  /** Tokens used by this task: main agent, sub-agents and supervisor. */
  get totalUsage(): Usage {
    return this.combinedUsage();
  }

  private combinedUsage(): Usage {
    let total = emptyUsage();
    for (const entry of this.agentUsage.values()) total = addUsage(total, entry.usage);
    return total;
  }

  /** Per-agent usage of this task, main agent first. */
  get usageByAgent(): AgentUsage[] {
    return [...this.agentUsage.values()].sort((a, b) => rank(a.agent) - rank(b.agent));
  }

  /** `unreported`: the calls came from an agent that does not report its tokens (they count as 0). */
  private recordUsage(agent: string, provider: string, model: string, usage: Usage, calls = 1, unreported = false): void {
    const entry = this.agentUsage.get(agent) ?? { agent, provider, model, calls: 0, usage: emptyUsage() };
    entry.provider = provider;
    entry.model = model || entry.model;
    entry.calls += calls;
    entry.usage = addUsage(entry.usage, usage);
    if (unreported) entry.unreported = true;
    this.agentUsage.set(agent, entry);
  }

  private emitUsage(): void {
    this.emit({ type: 'usage', total: this.combinedUsage(), model: this.lastModel, byAgent: this.usageByAgent });
  }

  /** Tell the model about something that happened outside the loop (e.g. the user reverted a file). */
  addNote(note: string): void {
    this.notes.push(note);
  }

  stop(): void {
    this.abort?.abort();
  }

  /** Durable state of the current task, for the history. */
  snapshot(): Pick<TaskSnapshot, 'messages' | 'systemPrompt' | 'subagentProfiles' | 'plan' | 'usageByAgent' | 'skills' | 'checkpoint'> {
    return {
      messages: this.messages,
      systemPrompt: this.systemPrompt,
      subagentProfiles: this.taskProfiles.map((p) => p.name),
      plan: this.plan,
      usageByAgent: this.usageByAgent,
      skills: this.taskSkills.map((s) => s.name),
      checkpoint: this.options.changes ? undefined : this.changes.exportCheckpoint(),
    };
  }

  /**
   * Continue a saved task: its conversation, frozen system prompt and tool list come back exactly
   * as they were, so the next turn extends the same prefix. Its unaccepted file changes come back
   * too (they can still be reverted). The supervisor starts a fresh review.
   */
  restore(state: Pick<TaskSnapshot, 'messages' | 'systemPrompt' | 'subagentProfiles' | 'plan' | 'usageByAgent' | 'skills' | 'checkpoint'>): void {
    if (this.abort) throw new Error('Stop the agent before opening another task.');
    this.generation++;
    this.messages = [...state.messages];
    this.systemPrompt = state.systemPrompt;
    this.plan = state.plan;
    this.notes = [];
    this.agentUsage = new Map(state.usageByAgent.map((u) => [u.agent, { ...u, usage: { ...u.usage } }]));
    this.lastProviderKey = undefined;
    this.userRequests = [];
    this.corrections = [];
    this.rewindPoints = [];
    // An external agent starts a fresh session with a brief of the task.
    this.dropAcpSession();
    this.shownNotices.clear();
    this.supervisor?.reset();
    this.options.permissions.resetSession();
    if (!this.options.changes) this.changes.importCheckpoint(state.checkpoint ?? []);
    // Rebuild from the full catalog: the task's tools must not depend on today's settings.
    const catalog = [...(this.options.subagents?.getProfiles() ?? []), ...DEFAULT_SUBAGENTS];
    const profiles = state.subagentProfiles
      .map((name) => catalog.find((p) => p.name === name))
      .filter((p): p is SubagentProfile => !!p);
    const skillNames = new Set(state.skills ?? []);
    const skills = (this.options.skills?.() ?? []).filter((s) => skillNames.has(s.name));
    const askedBefore = state.messages.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_call' && b.name === SUPERVISOR_TOOL));
    this.activity = [];
    this.secretFile = undefined;
    this.extraTools = [];
    this.extraLoaded = false;
    this.freezeTools(state.systemPrompt ? profiles : [], state.systemPrompt ? skills : [], !!state.systemPrompt && (askedBefore || this.supervisorEnabled()));
    this.emit({ type: 'reset' });
    this.emit({ type: 'plan', plan: this.plan });
    this.emitUsage();
  }

  private freezeTools(profiles: SubagentProfile[], skills: readonly Skill[], supervised: boolean): void {
    this.taskProfiles = profiles;
    this.taskSkills = skills;
    this.taskSupervised = supervised;
    const own = new Set(this.baseTools.map((tool) => tool.name));
    this.taskTools = [
      ...this.baseTools,
      ...(profiles.length ? [this.createSubagentTool(profiles)] : []),
      ...(skills.length ? [createSkillTool(skills)] : []),
      ...(supervised ? [this.createSupervisorTool()] : []),
      ...this.extraTools.filter((tool) => !own.has(tool.name)),
    ];
    this.taskToolsByName = new Map(this.taskTools.map((tool) => [tool.name, tool]));
  }

  /** Load the extra (MCP) tools; a failure only costs those tools, never the task. */
  private async loadExtraTools(): Promise<void> {
    this.extraLoaded = true;
    if (!this.options.getExtraTools) return;
    try {
      this.extraTools = await this.options.getExtraTools();
    } catch (error) {
      this.extraTools = [];
      this.emit({ type: 'notice', level: 'warning', message: t('MCP tools are not available: {error}', { error: errorMessage(error) }) });
    }
  }

  /** The fallback provider for an error that a different provider can get past (limits, outages). */
  private fallbackFor(failed: AIProvider, error: unknown): AIProvider | undefined {
    if (!(error instanceof ProviderError) || !['rate_limit', 'server', 'network'].includes(error.kind)) return undefined;
    try {
      const next = this.options.getFallbackProvider?.();
      return next && !(next.id === failed.id && next.model === failed.model) ? next : undefined;
    } catch {
      return undefined; // e.g. the fallback has no API key
    }
  }

  private supervisorEnabled(): boolean {
    return !!this.supervisor && !!this.options.supervisor?.getSettings().enabled;
  }

  /** Start a fresh task: new conversation, new system prompt snapshot, no plan. */
  reset(): void {
    this.stop();
    this.generation++;
    this.messages = [];
    this.systemPrompt = undefined;
    this.plan = undefined;
    this.notes = [];
    this.agentUsage.clear();
    this.rewindPoints = [];
    this.lastPromptTokens = 0;
    this.lastProviderKey = undefined;
    this.userRequests = [];
    this.corrections = [];
    this.activity = [];
    this.secretFile = undefined;
    this.extraTools = [];
    this.extraLoaded = false;
    this.dropAcpSession();
    this.shownNotices.clear();
    this.supervisor?.reset();
    this.options.permissions.resetSession();
    // The previous task's pending changes stay with that task (see snapshot/restore).
    if (!this.options.changes) this.changes.clear();
    this.emit({ type: 'reset' });
    this.emit({ type: 'plan', plan: undefined });
  }

  /**
   * Run one user request to completion. `attachments` are files the user attached (e.g. with @),
   * sent to the model with the request but shown to the user by name only. `skills` are skills the
   * user invoked for this request (e.g. "/unity ..."); their instructions ride along with it.
   */
  async run(
    userText: string,
    editor?: EditorContext,
    attachments: Array<{ path: string; content: string }> = [],
    options: { skills?: readonly Skill[]; images?: readonly AttachedImage[] } = {},
  ): Promise<RunEndReason> {
    if (this.abort) throw new Error('The agent is already running.');
    const abort = new AbortController();
    this.abort = abort;
    this.lastError = undefined;
    this.emit({ type: 'run_started' });
    let reason: RunEndReason = 'completed';
    try {
      reason = await this.loop(userText, editor, abort.signal, attachments, options.skills ?? [], options.images ?? []);
    } catch (error) {
      if (isAbortError(error) || abort.signal.aborted) {
        reason = 'stopped';
      } else {
        reason = 'error';
        this.lastError = errorMessage(error);
        const action = error instanceof ProviderError ? error.action : undefined;
        this.emit({ type: 'notice', level: 'error', message: this.lastError, action });
      }
    } finally {
      this.abort = undefined;
      this.setPhase('idle');
      this.emit({ type: 'run_finished', reason });
    }
    return reason;
  }

  private async loop(
    userText: string,
    editor: EditorContext | undefined,
    signal: AbortSignal,
    attachments: Array<{ path: string; content: string }>,
    invokedSkills: readonly Skill[],
    images: readonly AttachedImage[],
  ): Promise<RunEndReason> {
    const settings = this.options.getSettings();
    // A third-party agent as the main agent runs its own loop; Orka answers its requests.
    const external = this.options.role ? undefined : this.options.getExternalAgent?.();
    if (external) return this.externalLoop(external, userText, editor, signal, attachments, invokedSkills, images);
    // The agent's session would miss what a model does now: it gets a fresh one with a brief if it comes back.
    if (this.acp) this.acp.stale = true;
    // Resolve the provider first so a missing API key fails before anything is recorded.
    let provider = this.options.getProvider();

    this.setPhase('thinking');
    if (!this.systemPrompt) {
      // Freeze the task's tools, skills and prompt together; they must stay identical for the whole task.
      await this.loadExtraTools();
      const supervised = !this.options.role && this.supervisorEnabled();
      this.freezeTools(this.options.role ? [] : (this.options.subagents?.getProfiles() ?? []), this.options.skills?.() ?? [], supervised);
      this.systemPrompt = await this.context.buildSystemPrompt(settings.customInstructions, {
        role: this.options.role,
        subagents: this.taskProfiles,
        skills: this.taskSkills,
        supervisor: supervised,
        mcpServers: [...new Set(this.extraTools.map((tool) => /^mcp__(.+?)__/.exec(tool.name)?.[1]).filter((s): s is string => !!s))],
      });
    } else if (!this.extraLoaded) {
      // A restored task: its MCP tools come back once, when it continues.
      await this.loadExtraTools();
      this.freezeTools(this.taskProfiles, this.taskSkills, this.taskSupervised);
    }
    if (this.systemPrompt && !this.context.projectSummary) {
      // A restored task keeps its frozen prompt; rescan only for the supervisor's project context.
      await this.context.buildSystemPrompt(settings.customInstructions, { subagents: this.taskProfiles });
    }
    await this.recordRequest(userText, editor, attachments, invokedSkills, images);

    const task: RequestState = { codeChangedSinceCheck: false, verifyNudged: false, changedSinceHooks: false, hookRounds: 0, changedCode: false };
    const oversight = this.supervisor ? this.options.supervisor!.getSettings() : undefined;
    const watch: Watch = {
      active: !!oversight?.enabled,
      checkpoints: oversight?.frequency === 'checkpoints',
      interventions: 0,
      consultations: 0,
      planChecks: 0,
      stepsSinceProgress: 0,
      recent: [],
    };
    this.watch = watch;
    if (watch.active && !watch.checkpoints) this.supervisor!.note(`# The user's request\n${userText}`);
    const spentAtStart = spent(this.combinedUsage());
    /** Set once the agent's provider hit a limit in this request: the fallback finishes it. */
    let fallback: AIProvider | undefined;
    // A short question can go to the lighter model; the main model takes over if work is needed.
    let light: AIProvider | undefined;
    if (!this.options.role && !images.length && !invokedSkills.length && isSimpleRequest(userText)) {
      try {
        light = this.options.getLightProvider?.();
      } catch {
        light = undefined; // e.g. no API key for the light model: just use the main one
      }
      if (light) {
        this.emit({
          type: 'notice',
          level: 'info',
          message: t('A simple question: {model} answers it to save tokens. Changes would go back to the main model.', { model: `${light.label} · ${light.model}` }),
        });
      }
    }

    for (let iteration = 0; ; iteration++) {
      if (signal.aborted) return 'stopped';
      if (iteration >= settings.maxIterations) {
        this.emit({
          type: 'notice',
          level: 'warning',
          message: t('Paused after {n} steps. Send "continue" to let the agent keep going.', { n: settings.maxIterations }),
        });
        return 'max_iterations';
      }
      const used = spent(this.combinedUsage()) - spentAtStart;
      if (settings.tokenBudget && settings.tokenBudget > 0 && used >= settings.tokenBudget) {
        this.emit({
          type: 'notice',
          level: 'warning',
          message: t('Paused: this request used {used} tokens (budget {budget}). Send "continue" to allow another round, or raise the budget in the settings.', {
            used: used.toLocaleString('en-US'),
            budget: settings.tokenBudget.toLocaleString('en-US'),
          }),
        });
        return 'budget';
      }

      provider = fallback ?? light ?? this.options.getProvider();
      const providerKey = `${provider.id}|${provider.model}`;
      if (!this.options.role && this.lastProviderKey && this.lastProviderKey !== providerKey) {
        this.emit({
          type: 'notice',
          level: 'info',
          message: t('The main agent now runs on {model}. It continues this task with the same conversation.', { model: `${provider.label} · ${provider.model}` }),
        });
      }
      this.lastProviderKey = providerKey;
      const compaction = settings.compaction;
      if (compaction?.auto && this.lastPromptTokens >= compaction.thresholdTokens && this.messages.length > 2) {
        await this.compactConversation('auto', signal);
      }
      this.setPhase('thinking');
      const assistantId = this.nextId('a');
      this.emit({ type: 'assistant_start', id: assistantId });
      let response: ChatResponse;
      try {
        response = await provider.chat(
          { system: this.systemPrompt!, messages: this.messages, tools: this.taskTools.map(toSpec), signal },
          (event) => this.forwardStreamEvent(assistantId, event),
        );
      } catch (error) {
        const next = !fallback && !signal.aborted ? this.fallbackFor(provider, error) : undefined;
        if (!next) throw error;
        fallback = next;
        this.emit({ type: 'assistant_end', id: assistantId, text: '', model: '' });
        this.emit({
          type: 'notice',
          level: 'warning',
          message: t('{provider} is not available right now ({reason}); this request continues on {fallback}.', {
            provider: `${provider.label} · ${provider.model}`,
            reason: (error as ProviderError).kind === 'rate_limit' ? t('usage limit') : t('connection or server error'),
            fallback: `${next.label} · ${next.model}`,
          }),
        });
        // The switch is announced here; don't announce it again as a provider change.
        this.lastProviderKey = `${next.id}|${next.model}`;
        continue;
      }
      this.messages.push(response.message);
      this.lastModel = response.model;
      this.lastPromptTokens = response.usage.inputTokens + response.usage.cacheReadTokens + response.usage.cacheWriteTokens;
      this.recordUsage(this.options.role?.name ?? 'main', provider.id, response.model, response.usage);
      this.emitUsage();
      this.emit({ type: 'assistant_end', id: assistantId, text: messageText(response.message), model: response.model });

      const calls = response.message.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');

      if (response.stopReason === 'refusal') {
        this.answerUnexecuted(calls, 'Not executed: the response was declined by the model provider.');
        this.emit({
          type: 'notice',
          level: 'error',
          message: response.stopDetail
            ? t('The model declined this request ({detail}). Try rephrasing it.', { detail: response.stopDetail })
            : t('The model declined this request. Try rephrasing it.'),
        });
        return 'refusal';
      }

      if (response.stopReason === 'pause') continue;

      if (light && calls.some((c) => !READONLY_TOOLS.has(c.name) && !SHOW_TOOLS.has(c.name) && !this.isParallelSafe(c))) {
        // The light model wants to change something: that is the main model's job.
        this.answerUnexecuted(calls, 'Not executed: this request needs changes, so the main model continues it.');
        light = undefined;
        this.lastProviderKey = undefined;
        this.emit({ type: 'notice', level: 'info', message: t('This needs changes: the main model takes over.') });
        continue;
      }

      if (calls.length === 0) {
        if (response.stopReason === 'max_tokens') {
          this.emit({ type: 'notice', level: 'warning', message: t('The response hit the output limit. Send "continue" to resume.') });
          return 'completed';
        }
        const next = await this.afterFinalAnswer(describeTurn(response.message), task, watch, oversight, settings, signal);
        if (next !== undefined) {
          this.messages.push({ role: 'user', content: [{ type: 'text', text: next }] });
          continue;
        }
        if (signal.aborted) return 'stopped';
        if (!this.options.role && task.changedCode && settings.learnLessons !== false) await this.learnLessons(provider, signal);
        return 'completed';
      }

      if (response.stopReason === 'max_tokens') {
        // A tool input cut off by the output limit can still parse; never run it.
        this.answerUnexecuted(
          calls,
          'Not executed: your response hit the output token limit before this tool call was complete. ' +
            'Retry with smaller inputs (for example several edit_file calls instead of one huge write_file).',
        );
        continue;
      }

      const results: ToolResultBlock[] = [];
      const planBefore = planShape(this.plan);
      const doneBefore = this.plan?.steps.filter((s) => s.status === 'completed').length ?? 0;
      let progressed = false;
      const limit = Math.max(1, settings.maxParallelSubagents ?? 3);
      for (let i = 0; i < calls.length; ) {
        if (signal.aborted) {
          results.push({ type: 'tool_result', toolCallId: calls[i].id, content: 'Cancelled: the user stopped the agent.', isError: true });
          this.emit({ type: 'tool_call', call: { ...this.placeholderView(calls[i]), status: 'cancelled' } });
          i++;
          continue;
        }
        // Consecutive read-only sub-agents cannot conflict with each other: run them side by side.
        // Consecutive workers run side by side in their own copies of the workspace and are merged
        // afterwards. Everything else that can write (edits, commands) stays strictly sequential.
        let end = i + 1;
        if (limit > 1 && this.isParallelSafe(calls[i])) while (end < calls.length && this.isParallelSafe(calls[end])) end++;
        else if (limit > 1 && this.isWorkerCall(calls[i])) while (end < calls.length && this.isWorkerCall(calls[end])) end++;
        const batch = calls.slice(i, end);
        const outcomes =
          batch.length > 1 && this.isWorkerCall(batch[0])
            ? await this.runWorkersSideBySide(batch, limit, signal)
            : await mapLimit(batch, limit, (call) => this.executeToolCall(call, signal));
        for (const outcome of outcomes) {
          results.push(outcome.result);
          if (outcome.changedCode) {
            task.codeChangedSinceCheck = true;
            task.changedSinceHooks = true;
            task.changedCode = true;
            progressed = true;
          }
          if (outcome.ranCommand) task.codeChangedSinceCheck = false;
        }
        i = end;
      }
      this.noteActivity(calls, results, watch);
      if (signal.aborted) {
        this.messages.push({ role: 'user', content: results });
        return 'stopped';
      }
      // In parallel mode the supervisor reviews in the background while the agent keeps working, and
      // its correction for the previous step (if any) rides along with this step's results. In
      // blocking mode the agent waits for this step's review before continuing.
      let intervention = await this.takeIntervention(watch);
      const acted = calls.some((c) => !READONLY_TOOLS.has(c.name) && !SHOW_TOOLS.has(c.name));
      if (watch.checkpoints) {
        // Checkpoints: look only at decisive moments, and wait for the answer (it is about what comes next).
        const doneAfter = this.plan?.steps.filter((s) => s.status === 'completed').length ?? 0;
        watch.stepsSinceProgress = progressed || doneAfter > doneBefore ? 0 : watch.stepsSinceProgress + 1;
        const newPlan = planShape(this.plan) !== planBefore && !!this.plan?.steps.length;
        const stuck = stuckReason(watch.recent);
        let kind: CheckpointKind | undefined;
        let why = '';
        if (newPlan && watch.planChecks < 2) {
          kind = 'plan';
          watch.planChecks++;
        } else if (stuck) {
          kind = 'stuck';
          why = stuck;
          watch.recent = [];
        } else if (watch.stepsSinceProgress >= PROGRESS_STEPS) {
          kind = 'progress';
          why = t('{n} steps without visible progress', { n: watch.stepsSinceProgress });
          watch.stepsSinceProgress = 0;
        }
        if (kind && this.canIntervene(watch, oversight!)) {
          intervention = (await this.checkpoint(kind, why ? `# Why you are being asked\n${why}` : '', watch, signal, why)) ?? intervention;
        }
      } else if (this.canIntervene(watch, oversight!) && (oversight!.frequency === 'every_turn' || (oversight!.frequency === 'on_changes' && acted))) {
        watch.pending = this.startReview('step', describeTurn(response.message, results), signal);
        if (oversight!.mode === 'blocking') intervention = (await this.takeIntervention(watch)) ?? intervention;
      }
      this.messages.push({
        role: 'user',
        content: intervention ? [...results, { type: 'text', text: interventionText(intervention) }] : results,
      });
    }
  }

  /**
   * Record a user request: a rewind point, the message (with the turn context, attached files and
   * invoked skills) and its user_message event. Returns the message. Stopped (`signal`) before it is
   * recorded, it records nothing: after a new task, the request is not the new task's.
   */
  private async recordRequest(
    userText: string,
    editor: EditorContext | undefined,
    attachments: Array<{ path: string; content: string }>,
    invokedSkills: readonly Skill[],
    images: readonly AttachedImage[],
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    const turnContext = await this.context.buildTurnContext(editor, this.options.permissions.getMode(), this.notes);
    if (signal?.aborted) throw new AbortedError();
    this.notes = [];
    const attached = [
      ...invokedSkills.map(invokedSkillBlock),
      ...attachments.map((a) => `<attached_file path="${a.path}">\n${truncateMiddle(a.content, 60_000)}\n</attached_file>`),
    ].join('\n\n');
    const userMessageId = this.nextId('u');
    if (!this.options.role) {
      this.rewindPoints.push({
        id: userMessageId,
        text: userText,
        messageIndex: this.messages.length,
        epoch: this.changes.startEpoch(),
        plan: this.plan && structuredClone(this.plan),
        requests: this.userRequests.length,
        corrections: this.corrections.length,
      });
    }
    const message: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: `${turnContext}\n\n${userText}${attached ? `\n\n${attached}` : ''}` },
        ...images.map((i): ImageBlock => ({ type: 'image', mediaType: i.mediaType, data: i.data })),
      ],
    };
    this.messages.push(message);
    this.emit({
      type: 'user_message',
      id: userMessageId,
      text: userText,
      attachments: attachments.length ? attachments.map((a) => a.path) : undefined,
      skills: invokedSkills.length ? invokedSkills.map((s) => s.name) : undefined,
      images: images.length ? images.map((i) => ({ name: i.name, thumb: i.thumb })) : undefined,
    });
    this.userRequests.push(userText);
    return message;
  }

  /**
   * The agent says it is done. A correction from the review of the previous step comes first,
   * then the user's beforeFinish hooks, the verify nudge and the supervisor's final review.
   * Returns what to send back to the agent (it continues), or undefined when the request is done
   * or was stopped (the caller checks the signal). `answer` is the agent's final turn as
   * describeTurn writes it; `finalOnly` reviews from a compact brief whatever the frequency.
   */
  private async afterFinalAnswer(
    answer: string,
    task: RequestState,
    watch: Watch,
    oversight: SupervisorSettings | undefined,
    settings: OrchestratorSettings,
    signal: AbortSignal,
    finalOnly = false,
  ): Promise<string | undefined> {
    // A correction from the review of the previous step takes precedence over finishing.
    const late = await this.takeIntervention(watch);
    if (late) return interventionText(late);
    // The user's own checks run before the agent may finish; failures go back to it.
    const finishHooks = this.options.role ? [] : (settings.hooks?.beforeFinish ?? []);
    if (finishHooks.length && task.changedSinceHooks) {
      task.changedSinceHooks = false;
      if (task.hookRounds >= MAX_HOOK_ROUNDS) {
        this.emit({ type: 'notice', level: 'warning', message: t('The project checks (hooks) still fail after {n} rounds; the agent stops trying.', { n: MAX_HOOK_ROUNDS }) });
      } else {
        task.hookRounds++;
        const failed = (await this.runHooks('beforeFinish', finishHooks, signal)).filter((r) => !r.ok);
        if (signal.aborted) return undefined;
        if (failed.length) return hookFailureText(failed);
        // Passing project checks count as verification.
        task.codeChangedSinceCheck = false;
      }
    }
    if (settings.autoVerify && task.codeChangedSinceCheck && !task.verifyNudged) {
      task.verifyNudged = true;
      this.emit({ type: 'notice', level: 'info', message: t('Changes were not verified yet - asking the agent to build/test before finishing.') });
      return this.verifyNudge();
    }
    if (oversight && this.canIntervene(watch, oversight)) {
      let final: SupervisorReview | undefined;
      if (finalOnly || watch.checkpoints || oversight.frequency === 'final_only') {
        // One stateless review of a compact brief: the requests, plan, diff, and the agent's answer.
        final = await this.checkpoint('final', `# The agent's final answer\n${answer}`, watch, signal);
      } else {
        const diff = await this.changes.unifiedDiffs(FINAL_REVIEW_DIFF_CHARS).catch(() => '');
        const changed = diff ? `Net changes of this task (unified diff):\n${diff}` : 'Files changed in this task: none';
        watch.pending = this.startReview('final', `${answer}\n\n${changed}`, signal);
        final = await this.takeIntervention(watch);
      }
      if (final) return interventionText(final);
    }
    return undefined;
  }

  /**
   * One request handled by a third-party agent over ACP. The agent runs its own loop; Orka answers
   * its permission requests, file reads and writes and terminal commands (AcpAgentSession),
   * snapshots the workspace around each prompt so whatever the agent changed with its own tools is
   * listed and revertible, and keeps the end-of-request checks (hooks, verify nudge, the
   * Supervisor's final review), whose corrections go to the agent as its next prompt.
   *
   * The history gets plain text only (the request, then the agent's answer with a short activity
   * summary), so the task can continue on an API model later.
   */
  private async externalLoop(
    agent: ExternalAgentRuntime,
    userText: string,
    editor: EditorContext | undefined,
    signal: AbortSignal,
    attachments: Array<{ path: string; content: string }>,
    invokedSkills: readonly Skill[],
    images: readonly AttachedImage[],
  ): Promise<RunEndReason> {
    const settings = this.options.getSettings();
    // A new task or another opened task while this request runs: what is left of it belongs to no task.
    const generation = this.generation;
    const left = () => this.generation !== generation;
    this.setPhase('thinking');
    // The safety net comes first: without snapshots, what the agent changes with its own tools
    // could be neither reviewed nor reverted, so it does not start at all.
    const snapshots = this.options.commandSnapshots;
    const net = new Handoff({ id: agent.id, label: agent.label }, this.options.host.workspaceRoot, snapshots, this.changes);
    const noSnapshots = () =>
      new Error(
        snapshots
          ? t('{agent} cannot start: Orka cannot snapshot this folder ({reason}), so the files it changes could not be reviewed or reverted.', { agent: agent.label, reason: net.untrackedReason ?? '?' })
          : t('{agent} cannot start: turn on "Make command changes revertible" in the settings, so every file it changes can be reviewed and reverted.', { agent: agent.label }),
      );
    if (!(await net.begin())) throw noSnapshots();
    // The supervisor's briefs and the verify nudge need the project scan; no system prompt is
    // frozen (that happens if the task continues on a model).
    if (!this.context.projectSummary) await this.context.buildSystemPrompt(settings.customInstructions, { subagents: [] });
    if (signal.aborted) return 'stopped';
    const earlier = userRequests(this.messages);
    const request = await this.recordRequest(userText, editor, attachments, invokedSkills, images, signal);

    const task: RequestState = { codeChangedSinceCheck: false, verifyNudged: false, changedSinceHooks: false, hookRounds: 0, changedCode: false };
    const oversight = this.supervisor ? this.options.supervisor!.getSettings() : undefined;
    const watch: Watch = { active: !!oversight?.enabled, checkpoints: true, interventions: 0, consultations: 0, planChecks: 0, stepsSinceProgress: 0, recent: [] };
    this.watch = watch;
    if (watch.active && oversight!.frequency !== 'final_only') {
      this.noticeOnce('supervisor', t('With {agent} as the main agent, the Supervisor reviews only the final result: an outside agent cannot be corrected in the middle of its turn.', { agent: agent.label }));
    }
    if (settings.tokenBudget && settings.tokenBudget > 0) {
      this.noticeOnce('budget', t('{agent} does not report its token use, so the token budget cannot pause it.', { agent: agent.label }));
    }
    // A switch between a model and an agent mid-task is announced, either way.
    const agentKey = `agent:${agent.id}`;
    if (this.lastProviderKey && this.lastProviderKey !== agentKey) {
      this.emit({ type: 'notice', level: 'info', message: t('{agent} takes over as the main agent, with a summary of this task so far.', { agent: agent.label }) });
    }
    this.lastProviderKey = agentKey;

    // Stop works while the agent starts (initialize) and opens its session (session/new) too.
    let client: AcpClient;
    try {
      client = await agent.acquire(signal);
    } catch (error) {
      throw this.agentError(agent, error);
    }
    let opened = false;
    try {
      const { session, fresh } = await this.acpSessionFor(agent, client, signal);
      opened = true;
      let blocks = await this.firstAcpPrompt(agent, session, request, fresh ? earlier : []);
      for (let round = 0; ; round++) {
        if (signal.aborted || left()) return 'stopped';
        if (round >= settings.maxIterations) {
          this.emit({ type: 'notice', level: 'warning', message: t('Paused after {n} steps. Send "continue" to let the agent keep going.', { n: settings.maxIterations }) });
          return 'max_iterations';
        }
        if (round > 0) {
          const tracking = await net.begin();
          if (signal.aborted || left()) return 'stopped';
          if (!tracking) throw noSnapshots();
        }
        this.setPhase('thinking');
        // The agent does not report tokens: the call is counted, its usage is marked unreported.
        this.recordUsage('main', `agent:${agent.id}`, agent.label, emptyUsage(), 1, true);
        this.lastModel = agent.label;
        this.emitUsage();
        let result: AcpTurnResult | undefined;
        let failure: unknown;
        try {
          // A file the agent writes through Orka keeps its content from the turn's snapshot as its
          // original; a write still under way after a new task records nothing into that one.
          result = await session.prompt(blocks, signal, { recordBefore: (absPath) => net.recordBefore(absPath, () => !left()) });
        } catch (error) {
          failure = error;
        }
        if (left()) return 'stopped';
        // Also after a failure: what the agent wrote before it stopped stays reviewable.
        const changed: CommandChange[] = await net.collect(false, () => !left()).catch(() => []);
        if (left()) return 'stopped';
        if (!result) throw this.agentError(agent, failure);
        const files = changed.map((c) => `${c.path} (${c.status})`);
        this.activity = [...this.activity, ...result.activity, ...(files.length ? [`- files changed: ${files.slice(0, 20).join(', ')}`] : [])].slice(-ACTIVITY_LINES);
        if (result.changedCode || changed.some((c) => !NON_CODE_EXTENSIONS.has(path.extname(c.path).toLowerCase()))) {
          task.changedCode = true;
          task.changedSinceHooks = true;
          task.codeChangedSinceCheck = !result.ranCommandAfterChange;
        } else if (result.ranCommandAfterChange) task.codeChangedSinceCheck = false;
        this.messages.push({ role: 'assistant', content: [{ type: 'text', text: agentTurnText(agent.label, result.text.trim(), result.activity, files) }] });

        if (signal.aborted || result.stopReason === 'cancelled') return 'stopped';
        if (result.stopReason === 'refusal') {
          this.emit({ type: 'notice', level: 'error', message: t('The model declined this request. Try rephrasing it.') });
          return 'refusal';
        }
        if (result.stopReason === 'max_turn_requests') {
          this.emit({ type: 'notice', level: 'warning', message: t('{agent} reached its own limit of model requests for one turn. Send "continue" to let it keep going.', { agent: agent.label }) });
          return 'max_iterations';
        }
        if (result.stopReason === 'max_tokens') {
          this.emit({ type: 'notice', level: 'warning', message: t('The response hit the output limit. Send "continue" to resume.') });
          return 'completed';
        }
        const answer = describeTurn({ role: 'assistant', content: [{ type: 'text', text: (result.lastText || result.text).trim() }] });
        const next = await this.afterFinalAnswer(answer, task, watch, oversight, settings, signal, true);
        if (next === undefined || left()) return signal.aborted ? 'stopped' : 'completed';
        this.messages.push({ role: 'user', content: [{ type: 'text', text: next }] });
        blocks = [{ type: 'text', text: withNotes(session.takeNotes(), next) }];
      }
    } finally {
      // Stopped before the agent opened its session: it may be stuck, so its process stops unless in use.
      agent.release(client, !opened && signal.aborted);
    }
  }

  /**
   * The task's ACP session with this agent process; a fresh one after a rewind, a restored task,
   * another agent, or when the process was restarted.
   */
  private async acpSessionFor(agent: ExternalAgentRuntime, client: AcpClient, signal: AbortSignal): Promise<{ session: AcpAgentSession; fresh: boolean }> {
    const current = this.acp;
    if (current && !current.stale && current.agentId === agent.id && current.session.client === client && client.alive) return { session: current.session, fresh: false };
    this.dropAcpSession();
    const context: AcpSessionContext = {
      host: this.options.host,
      permissions: this.options.permissions,
      changes: this.changes,
      emit: (event) => this.emit(event),
      setPlan: (plan) => {
        this.plan = plan;
        this.emit({ type: 'plan', plan });
      },
      nextId: (prefix) => this.nextId(prefix),
      afterEdit: (absPath, signal) => this.afterEditHooks(absPath, signal),
      secretFile: () => this.secretFile,
      noteSecret: (relPath) => {
        this.secretFile ??= relPath;
      },
      label: agent.label,
      commandTimeoutMs: this.options.getSettings().commandTimeoutMs,
    };
    const session = new AcpAgentSession(client, context);
    try {
      await session.start(signal);
      // Stopped (or a new task) meanwhile: the session must not become the next task's.
      if (signal.aborted) throw new AbortedError();
    } catch (error) {
      session.dispose();
      throw this.agentError(agent, error);
    }
    this.acp = { agentId: agent.id, session, stale: false };
    return { session, fresh: true };
  }

  /**
   * The request as the agent's prompt: the same text the history has (turn context, request,
   * attached files and skills), images when the agent takes them, notes from its last turn, and
   * for a fresh session in a task already under way, a brief of where the task stands.
   */
  private async firstAcpPrompt(agent: ExternalAgentRuntime, session: AcpAgentSession, request: ChatMessage, earlier: readonly string[]): Promise<ContentBlock[]> {
    const text = request.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');
    const images = request.content.filter((b): b is ImageBlock => b.type === 'image');
    // Said before anything is awaited: once a new task starts, this request emits nothing into it.
    if (images.length && !session.acceptsImages) {
      this.emit({ type: 'notice', level: 'warning', message: t('{agent} does not accept images, so the attached images were not sent.', { agent: agent.label }) });
    }
    let brief = '';
    if (earlier.length) {
      const changed = await this.changes.list().catch(() => []);
      brief = handoffBrief({
        requests: earlier,
        plan: this.plan,
        changedFiles: changed.map((c) => c.relPath),
        note: '[Orka] You are taking over a task that is already under way; its earlier conversation is not available to you. This is where it stands.',
      });
    }
    const prompt = withNotes(session.takeNotes(), brief ? `${brief}\n\n# New request\n${text}` : text);
    return [
      { type: 'text', text: prompt },
      ...(session.acceptsImages ? images.map((i): ContentBlock => ({ type: 'image', mimeType: i.mediaType, data: i.data })) : []),
    ];
  }

  /** A failure of the external agent as the user should see it; a missing sign-in names the vendor's login command. */
  private agentError(agent: ExternalAgentRuntime, error: unknown): Error {
    if (isAbortError(error)) return error as Error;
    const message = errorMessage(error);
    const authRequired = (error instanceof JsonRpcError && error.code === ACP_AUTH_REQUIRED) || AUTH_FAILURE.test(message);
    if (authRequired) {
      return new ProviderError(
        agent.loginCommand
          ? t('{agent} is not signed in. Run "{command}" in a terminal and sign in there, then send your message again.', { agent: agent.label, command: agent.loginCommand })
          : t('{agent} is not signed in. Sign in with its own login, then send your message again.', { agent: agent.label }),
        'auth',
      );
    }
    return new Error(message.startsWith(agent.label) ? message : `${agent.label}: ${message}`);
  }

  private dropAcpSession(): void {
    this.acp?.session.dispose();
    this.acp = undefined;
  }

  private noticeOnce(key: string, message: string): void {
    if (this.shownNotices.has(key)) return;
    this.shownNotices.add(key);
    this.emit({ type: 'notice', level: 'info', message });
  }

  /** User messages this task can go back to, oldest first. */
  get rewindTargets(): ReadonlyArray<{ id: string; text: string }> {
    return this.rewindPoints.map(({ id, text }) => ({ id, text }));
  }

  /**
   * Go back to just before a user message: the conversation from that message on is dropped, the
   * plan is what it was then, and files the agents changed since are restored. Returns the
   * message's text (to edit and send again) and the restored files; undefined when that point is
   * gone (the task was compacted or reopened since).
   */
  async rewind(id: string): Promise<{ text: string; restored: string[] } | undefined> {
    if (this.abort) throw new Error('Stop the agent before going back.');
    const index = this.rewindPoints.findIndex((p) => p.id === id);
    if (index === -1) return undefined;
    const point = this.rewindPoints[index];
    const restored = await this.changes.rewindTo(point.epoch);
    // An ACP agent's conversation cannot be cut back: the next request starts a fresh session with a brief.
    if (this.acp) this.acp.stale = true;
    this.rewindPoints = this.rewindPoints.slice(0, index);
    this.messages = this.messages.slice(0, point.messageIndex);
    this.plan = point.plan;
    this.userRequests = this.userRequests.slice(0, point.requests);
    this.corrections = this.corrections.slice(0, point.corrections);
    this.notes = [];
    this.activity = [];
    this.lastPromptTokens = 0;
    this.supervisor?.reset();
    this.emit({ type: 'rewound', id });
    this.emit({ type: 'plan', plan: this.plan });
    return { text: point.text, restored };
  }

  /** Compact the conversation now (e.g. the user's /compact). */
  async compact(): Promise<boolean> {
    if (this.abort) throw new Error('The agent is running; stop it or wait before compacting.');
    let external: ExternalAgentRuntime | undefined;
    try {
      external = this.options.getExternalAgent?.();
    } catch {
      external = undefined;
    }
    if (external) {
      // Its context lives in the agent; Orka's copy of the conversation is plain text and stays as it is.
      this.emit({ type: 'notice', level: 'info', message: t('{agent} keeps its own context; there is nothing for Orka to compact.', { agent: external.label }) });
      return false;
    }
    if (this.messages.length < 3) {
      this.emit({ type: 'notice', level: 'info', message: t('Nothing to compact yet.') });
      return false;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.emit({ type: 'run_started' });
    let ok = false;
    try {
      ok = await this.compactConversation('manual', abort.signal);
    } finally {
      this.abort = undefined;
      this.setPhase('idle');
      this.emit({ type: 'run_finished', reason: abort.signal.aborted ? 'stopped' : 'completed' });
    }
    return ok;
  }

  /**
   * Replace the conversation with one handoff message: a note the model writes for itself, plus
   * the state the orchestrator knows for certain (plan, changed files, the user's requests,
   * supervisor corrections, the latest tool results). The new history replays no earlier turns,
   * so it is valid for every provider, and the system prompt and tools stay the same.
   */
  private async compactConversation(reason: 'auto' | 'manual', signal: AbortSignal): Promise<boolean> {
    const id = this.nextId('c');
    const beforeTokens = this.lastPromptTokens || estimateTokens(this.messages);
    this.emit({ type: 'compaction', id, status: 'running', reason, beforeTokens });
    this.setPhase('thinking');
    try {
      const provider = this.options.getProvider();
      // Ask for the note at the end of the current history (same prefix: cheap with caching).
      const request = [...this.messages];
      const last = request[request.length - 1];
      if (last.role === 'user') request[request.length - 1] = { role: 'user', content: [...last.content, { type: 'text', text: COMPACT_REQUEST }] };
      else request.push({ role: 'user', content: [{ type: 'text', text: COMPACT_REQUEST }] });
      const response = await provider.chat({ system: this.systemPrompt!, messages: request, tools: this.taskTools.map(toSpec), signal }, () => {});
      this.recordUsage(this.options.role?.name ?? 'main', provider.id, response.model, response.usage);
      const note = messageText(response.message).trim();
      if (!note) throw new Error('The model returned an empty handoff note.');

      const handoff = await this.buildHandoff(note, last);
      this.messages = [{ role: 'user', content: [{ type: 'text', text: handoff }] }];
      this.lastPromptTokens = 0;
      // The earlier messages are gone, so there is nothing to go back to.
      this.rewindPoints = [];
      if (!this.options.changes) this.changes.clearEpochs();
      // The supervisor's own history is replaced by the same handoff.
      this.supervisor?.reset();
      this.supervisor?.note(`# Handoff after compaction\n${handoff}`);
      const afterTokens = estimateTokens(this.messages);
      this.emit({ type: 'compaction', id, status: 'done', reason, beforeTokens, afterTokens, summary: note });
      this.emitUsage();
      return true;
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        this.emit({ type: 'compaction', id, status: 'error', reason, message: 'Compaction was cancelled.' });
        throw error;
      }
      // Keep going on the full history; compaction is an optimization, not a requirement.
      this.emit({ type: 'compaction', id, status: 'error', reason, message: errorMessage(error) });
      return false;
    }
  }

  private async buildHandoff(note: string, last: ChatMessage): Promise<string> {
    const changes = await this.changes.list().catch(() => []);
    const files = changes.length
      ? changes.map((c) => `- ${c.status} ${c.relPath} (+${c.added} -${c.removed})`).join('\n')
      : '- none';
    const requests = this.userRequests.slice(-6).map((r, i) => `${i + 1}. ${truncateMiddle(r, 2000)}`).join('\n');
    const corrections = this.corrections.slice(-5).map((c) => `- ${truncateMiddle(c, 800)}`).join('\n');
    const pendingResults =
      last.role === 'user'
        ? last.content
            .filter((b): b is ToolResultBlock => b.type === 'tool_result')
            .map((b) => `<result${b.isError ? ' error="true"' : ''}>\n${truncateMiddle(b.content, 3000)}\n</result>`)
            .join('\n')
        : '';
    return [
      '[Task handoff] The earlier conversation of this task was compacted to save context. Everything you need to continue is below.',
      `<handoff_note>\n${note}\n</handoff_note>`,
      '<orchestrator_state>',
      `User requests in this task (verbatim, oldest first):\n${requests || '(none)'}`,
      `Plan:\n${this.plan ? formatPlan(this.plan) : '(no plan)'}`,
      `Files changed in this task:\n${files}`,
      corrections ? `Supervisor corrections still in force:\n${corrections}` : '',
      pendingResults ? `Results of your most recent tool calls:\n${pendingResults}` : '',
      '</orchestrator_state>',
      'Continue the task from here. Re-read files before editing them; do not assume their contents from memory.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** A read-only sub-agent delegation: safe to run in parallel with others like it. */
  private isParallelSafe(call: ToolCallBlock): boolean {
    if (call.name !== SUBAGENT_TOOL) return false;
    return this.taskProfiles.find((p) => p.name === call.input.agent)?.access === 'readonly';
  }

  /** A delegation to a sub-agent that edits files (a worker). */
  private isWorkerCall(call: ToolCallBlock): boolean {
    if (call.name !== SUBAGENT_TOOL) return false;
    return this.taskProfiles.find((p) => p.name === call.input.agent)?.access === 'full';
  }

  /**
   * Several workers at once: each gets its own copy of the workspace (from a fresh snapshot), they
   * run side by side, and then their changes are merged into the workspace one worker at a time,
   * in the order they were called. Without snapshots (no git, or turned off) they run one after
   * another in the workspace instead.
   */
  private async runWorkersSideBySide(
    batch: ToolCallBlock[],
    limit: number,
    signal: AbortSignal,
  ): Promise<Array<{ result: ToolResultBlock; changedCode: boolean; ranCommand: boolean }>> {
    const snapshots = this.options.commandSnapshots;
    const base = this.options.getSettings().parallelWorkers !== false && snapshots ? await snapshots.snapshot() : undefined;
    const sequential = async () => {
      const outcomes: Array<{ result: ToolResultBlock; changedCode: boolean; ranCommand: boolean }> = [];
      for (const call of batch) outcomes.push(await this.executeToolCall(call, signal));
      return outcomes;
    };
    if (!base || !snapshots) return sequential();
    try {
      for (const call of batch) this.isolated.set(call.id, { copy: await WorkspaceCopy.create(snapshots, base) });
    } catch {
      for (const run of this.isolated.values()) await run.copy.dispose();
      this.isolated.clear();
      return sequential();
    }
    try {
      const outcomes = await mapLimit(batch, limit, (call) => this.executeToolCall(call, signal));
      if (signal.aborted) return outcomes;
      for (let k = 0; k < batch.length; k++) {
        const run = this.isolated.get(batch[k].id)!;
        if (!run.changes?.length) continue;
        const merge = await mergeCopy(run.copy, run.changes, this.options.host, snapshots, this.changes);
        const lines = [
          merge.applied.length ? `Merged into the workspace: ${merge.applied.join(', ')}.` : '',
          merge.skipped.length ? `Binary files not merged (left only in the worker's copy): ${merge.skipped.join(', ')}.` : '',
          ...merge.conflicts.map((c) => `CONFLICT in ${c.path}: it also changed in the workspace in an overlapping way, so the workspace version was kept. The worker's change was:\n${truncateMiddle(c.diff, 6000)}`),
        ].filter(Boolean);
        const outcome = outcomes[k];
        outcome.result = { ...outcome.result, content: `${outcome.result.content}\n\n${lines.join('\n')}` };
        if (merge.applied.length) outcome.changedCode = true;
        if (merge.conflicts.length) {
          this.emit({ type: 'notice', level: 'warning', message: t('Workers changed the same lines of {files}; the first version was kept and the agent was told.', { files: merge.conflicts.map((c) => c.path).join(', ') }) });
        }
      }
      return outcomes;
    } finally {
      for (const call of batch) {
        await this.isolated.get(call.id)?.copy.dispose();
        this.isolated.delete(call.id);
      }
    }
  }

  private canIntervene(watch: { active: boolean; interventions: number }, oversight: SupervisorSettings): boolean {
    return watch.active && watch.interventions < oversight.maxInterventions;
  }

  /** Start a supervisor review; resolves to the review only if it asks for a correction. */
  private startReview(scope: 'step' | 'final', activity: string, signal: AbortSignal): Promise<SupervisorReview | undefined> {
    const id = this.nextId('s');
    this.emit({ type: 'supervisor', id, scope, status: 'reviewing' });
    return this.supervisor!.review(scope, activity, signal).then(
      (review) => {
        this.recordUsage('supervisor', review.provider, review.model, review.usage);
        if (review.verdict === 'intervene') this.corrections.push(review.message);
        this.emit({
          type: 'supervisor',
          id,
          scope,
          status: review.verdict === 'intervene' ? 'intervened' : 'ok',
          message: review.message || undefined,
          model: review.model,
        });
        return review.verdict === 'intervene' ? review : undefined;
      },
      (error) => {
        this.emit({ type: 'supervisor', id, scope, status: signal.aborted ? 'cancelled' : 'error', message: signal.aborted ? undefined : errorMessage(error) });
        return undefined;
      },
    );
  }

  /**
   * A checkpoint review: one stateless supervisor call on a compact brief (cost does not grow with
   * the task). Resolves to the review only if it asks for a correction, which is counted.
   */
  private async checkpoint(kind: CheckpointKind, extra: string, watch: Watch, signal: AbortSignal, reason?: string): Promise<SupervisorReview | undefined> {
    const id = this.nextId('s');
    this.emit({ type: 'supervisor', id, scope: kind, status: 'reviewing', reason: reason || undefined });
    try {
      const brief = await this.supervisorBrief(extra);
      const review = await this.supervisor!.check(kind, brief, signal);
      this.recordUsage('supervisor', review.provider, review.model, review.usage);
      this.emitUsage();
      const intervened = review.verdict === 'intervene';
      this.emit({ type: 'supervisor', id, scope: kind, status: intervened ? 'intervened' : 'ok', message: review.message || undefined, model: review.model, reason: reason || undefined });
      if (!intervened) return undefined;
      this.corrections.push(review.message);
      watch.interventions++;
      return review;
    } catch (error) {
      this.emit({ type: 'supervisor', id, scope: kind, status: signal.aborted ? 'cancelled' : 'error', message: signal.aborted ? undefined : errorMessage(error) });
      if (signal.aborted) throw error;
      return undefined;
    }
  }

  /** What the supervisor needs to judge the work, kept short: requests, plan, diff, recent activity, earlier corrections. */
  private async supervisorBrief(extra = ''): Promise<string> {
    const requests = this.userRequests.slice(-5).map((r, i) => `${i + 1}. ${truncateMiddle(r, 2000)}`).join('\n');
    const diff = await this.changes.unifiedDiffs(FINAL_REVIEW_DIFF_CHARS / 2).catch(() => '');
    const corrections = this.corrections.slice(-4).map((c) => `- ${truncateMiddle(c, 600)}`).join('\n');
    return [
      `# What the user asked (verbatim, oldest first)\n${requests || '(nothing yet)'}`,
      `# Plan\n${this.plan ? formatPlan(this.plan) : '(no plan)'}`,
      `# Changes so far\n${diff ? `Unified diff of the task's net changes:\n${diff}` : 'No file changes yet.'}`,
      `# Recent agent activity (oldest first)\n${this.activity.length ? this.activity.join('\n') : '(none)'}`,
      corrections ? `# Your earlier corrections in this task\n${corrections}` : '',
      extra,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** Remember one line per tool call for briefs, and outcomes for stuck detection. */
  private noteActivity(calls: ToolCallBlock[], results: ToolResultBlock[], watch: Watch): void {
    const byId = new Map(results.map((r) => [r.toolCallId, r]));
    for (const call of calls) {
      const result = byId.get(call.id);
      if (!result || call.name === SUPERVISOR_TOOL) continue;
      const declined = result.content.startsWith('The user declined');
      const status = !result.isError ? 'ok' : `ERROR: ${oneLine(result.content, 160)}`;
      this.activity.push(`- ${call.name}(${argSummary(call.input)}) -> ${status}`);
      if (!declined) watch.recent.push({ key: `${call.name}:${JSON.stringify(call.input).slice(0, 400)}`, error: !!result.isError });
    }
    this.activity = this.activity.slice(-ACTIVITY_LINES);
    watch.recent = watch.recent.slice(-8);
  }

  private createSupervisorTool(): Tool<{ question: string }> {
    return {
      name: SUPERVISOR_TOOL,
      description:
        'Ask the supervisor - a separate reviewer model - for guidance when you are stuck (the same error keeps coming back, ' +
        'several attempts failed), unsure which approach is right, or about to make a hard-to-reverse decision. Explain the ' +
        'problem, what you tried and what you are considering. It sees the user\'s request, the plan, the diff and your recent ' +
        'steps, and answers with advice; it does not do the work. Each question costs tokens: never ask about routine steps.',
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string', description: 'The problem, what you tried, and what you want to know.' } },
        required: ['question'],
      },
      describe: (input) => ({ category: 'read', risk: 'safe', title: t('Ask the supervisor: {question}', { question: oneLine(input.question, 80) }), detail: input.question }),
      execute: (input, ctx) => this.askSupervisor(input.question, ctx.signal),
    };
  }

  private async askSupervisor(question: string, signal: AbortSignal) {
    const watch = this.watch;
    const settings = this.options.supervisor?.getSettings();
    if (!this.supervisor || !settings?.enabled || !watch) return { content: 'The supervisor is turned off. Decide on your own.' };
    if (watch.consultations >= settings.maxInterventions) {
      return { content: `You already asked the supervisor ${watch.consultations} times in this request. Decide on your own now.` };
    }
    watch.consultations++;
    const brief = await this.supervisorBrief();
    try {
      const answer = await this.supervisor.consult(question, brief, signal);
      this.recordUsage('supervisor', answer.provider, answer.model, answer.usage);
      this.emitUsage();
      return { content: `[Supervisor advice - ${answer.model}]\n${answer.advice}` };
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      throw new ToolError(`The supervisor could not answer: ${errorMessage(error)}. Continue on your own.`);
    }
  }

  /** Wait for the pending review (if any) and return its correction, counting it. */
  private async takeIntervention(watch: { active: boolean; interventions: number; pending?: Promise<SupervisorReview | undefined> }): Promise<SupervisorReview | undefined> {
    if (!watch.pending) return undefined;
    const review = await watch.pending;
    watch.pending = undefined;
    this.emitUsage();
    if (!review) return undefined;
    watch.interventions++;
    return review;
  }

  private async executeToolCall(
    call: ToolCallBlock,
    signal: AbortSignal,
  ): Promise<{ result: ToolResultBlock; changedCode: boolean; ranCommand: boolean }> {
    const fail = (content: string, view?: Partial<ToolCallView>) => {
      this.emit({ type: 'tool_call', call: { ...this.placeholderView(call), status: 'error', output: content, ...view } });
      return { result: { type: 'tool_result' as const, toolCallId: call.id, content, isError: true }, changedCode: false, ranCommand: false };
    };

    const tool = this.taskToolsByName.get(call.name);
    if (!tool) return fail(`Unknown tool "${call.name}". Available tools: ${[...this.taskToolsByName.keys()].join(', ')}.`);
    if (INVALID_JSON_KEY in call.input) {
      return fail(JSON.stringify({ INVALID_JSON: String(call.input[INVALID_JSON_KEY]) }));
    }
    const invalid = validateInput(tool.inputSchema, call.input);
    if (invalid) return fail(`Invalid input: ${invalid}. Input received: ${truncateMiddle(JSON.stringify(call.input), 2000)}`);

    let output = '';
    const ctx: ToolContext = {
      callId: call.id,
      host: this.options.host,
      changes: this.changes,
      signal,
      commandTimeoutMs: this.options.getSettings().commandTimeoutMs,
      plan: this.plan,
      setPlan: (plan) => {
        this.plan = plan;
        this.emit({ type: 'plan', plan });
      },
      onOutput: (chunk) => {
        output += chunk;
        this.emit({ type: 'tool_output', id: call.id, chunk });
      },
    };

    let action: ToolAction;
    try {
      action = await tool.describe(call.input, ctx);
    } catch (error) {
      return fail(errorMessage(error));
    }
    // Once this task has read something that may hold secrets, nothing goes to the internet
    // without the user seeing it: a prompt injection could otherwise send the secrets out.
    // MCP tools reach outside the machine too (a browser, a database, a web service).
    const secretsGuard = (action.category === 'network' || call.name.startsWith('mcp__')) && this.secretFile !== undefined;
    if (secretsGuard) {
      action = {
        ...action,
        detail: `${action.detail ? `${action.detail}\n` : ''}${t('Asking because this task has read a file that may contain secrets ({file}).', { file: this.secretFile! })}`,
      };
    }

    const view: ToolCallView = {
      id: call.id,
      name: call.name,
      title: action.title,
      category: action.category,
      risk: action.risk,
      status: 'running',
      detail: action.detail,
      path: action.preview?.path ?? targetPath(this.options.host.workspaceRoot, call.input),
    };
    this.setPhase(phaseFor(call.name, action.category));

    let decision = this.options.permissions.decide(action);
    if (secretsGuard && decision === 'allow') decision = 'ask';
    if (decision === 'deny') {
      return fail('Denied by permission settings.', { ...view, status: 'denied' });
    }
    if (decision === 'ask') {
      this.emit({ type: 'tool_call', call: { ...view, status: 'awaiting_approval', hasPreview: !!action.preview } });
      const answer = await Promise.race([
        this.options.host.requestApproval({
          id: call.id,
          toolName: call.name,
          category: action.category,
          risk: action.risk,
          title: action.title,
          detail: action.detail,
          preview: action.preview,
        }),
        abortPromise(signal),
      ]);
      if (!answer || signal.aborted) {
        this.emit({ type: 'tool_call', call: { ...view, status: 'cancelled' } });
        return {
          result: { type: 'tool_result', toolCallId: call.id, content: 'Cancelled: the user stopped the agent.', isError: true },
          changedCode: false,
          ranCommand: false,
        };
      }
      if (!answer.approved) {
        const feedback = answer.feedback?.trim();
        const content = `The user declined this action.${feedback ? ` User feedback: ${feedback}` : ' Do not retry it unchanged; adjust your approach or ask the user.'}`;
        this.emit({ type: 'tool_call', call: { ...view, status: 'denied', output: feedback ? `Declined: ${feedback}` : 'Declined' } });
        return { result: { type: 'tool_result', toolCallId: call.id, content, isError: true }, changedCode: false, ranCommand: false };
      }
      if (answer.alwaysAllow) this.options.permissions.grantForSession(action);
    }

    this.emit({ type: 'tool_call', call: view });
    // A command that can change files runs between two snapshots, so its changes can be reviewed and reverted.
    const snapshots = call.name === 'run_command' && action.risk !== 'safe' ? this.options.commandSnapshots : undefined;
    const before = snapshots ? await snapshots.snapshot() : undefined;
    // A worker sub-agent's edits land in the shared change list rather than in this call's category.
    let delegatedEdits = false;
    const watchDelegate = call.name === SUBAGENT_TOOL ? this.changes.onDidChange(() => (delegatedEdits = true)) : undefined;
    try {
      const result = await tool.execute(call.input, ctx).finally(() => watchDelegate?.());
      const byCommand = before ? await this.recordCommandChanges(snapshots!, before) : [];
      const note = byCommand.length
        ? `\n\nFiles changed by this command (revertible in the Changes panel): ${byCommand.slice(0, 30).map((c) => `${c.path} (${c.status})`).join(', ')}${byCommand.length > 30 ? `, and ${byCommand.length - 30} more` : ''}`
        : '';
      const hooks = action.category === 'edit' && !result.isError && view.path ? await this.afterEditHooks(view.path, signal) : '';
      const content = truncateMiddle(result.content, MAX_TOOL_RESULT_CHARS) + note + hooks;
      this.emit({ type: 'tool_call', call: { ...view, status: result.isError ? 'error' : 'done', output: content, image: result.thumb } });
      const changedCode =
        ((action.category === 'edit' || action.category === 'delete') &&
          !result.isError &&
          !NON_CODE_EXTENSIONS.has(path.extname(view.path ?? '').toLowerCase())) ||
        byCommand.some((c) => !NON_CODE_EXTENSIONS.has(path.extname(c.path).toLowerCase())) ||
        delegatedEdits;
      const ranCommand = call.name === 'run_command' && !signal.aborted;
      if (!result.isError && this.secretFile === undefined) this.secretFile = secretTouched(call);
      const images = result.images?.length ? { images: result.images } : {};
      return { result: { type: 'tool_result', toolCallId: call.id, content, isError: result.isError, ...images }, changedCode, ranCommand };
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        this.emit({ type: 'tool_call', call: { ...view, status: 'cancelled', output } });
        return {
          result: { type: 'tool_result', toolCallId: call.id, content: 'Cancelled: the user stopped the agent.', isError: true },
          changedCode: false,
          ranCommand: false,
        };
      }
      const message = error instanceof ToolError ? error.message : `Tool failed: ${errorMessage(error)}`;
      this.emit({ type: 'tool_call', call: { ...view, status: 'error', output: message } });
      return { result: { type: 'tool_result', toolCallId: call.id, content: message, isError: true }, changedCode: false, ranCommand: false };
    }
  }

  /** Files a command changed since the snapshot join the change list with their original content. */
  private async recordCommandChanges(snapshots: ShadowGit, before: string): Promise<CommandChange[]> {
    try {
      return await recordChangesSince(snapshots, before, this.changes, this.options.host.workspaceRoot);
    } catch {
      return [];
    }
  }

  /**
   * After a request that changed code, in projects with a memory folder: ask for a few durable
   * lessons and append the new ones to `.project-ai/lessons.md`, so later tasks start knowing them.
   * The exchange joins the conversation (append-only, so every provider's cache stays valid).
   */
  private async learnLessons(provider: AIProvider, signal: AbortSignal): Promise<void> {
    const host = this.options.host;
    if (!(await host.isDirectory(path.join(host.workspaceRoot, MEMORY_DIR)))) return;
    this.setPhase('thinking');
    try {
      this.messages.push({ role: 'user', content: [{ type: 'text', text: LESSONS_REQUEST }] });
      const response = await provider.chat({ system: this.systemPrompt!, messages: this.messages, tools: this.taskTools.map(toSpec), signal }, () => {});
      this.messages.push(response.message);
      this.recordUsage(this.options.role?.name ?? 'main', provider.id, response.model, response.usage);
      this.emitUsage();
      const calls = response.message.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
      // Every tool call needs a result; these are never run.
      if (calls.length) this.messages.push({ role: 'user', content: calls.map((c) => ({ type: 'tool_result', toolCallId: c.id, content: 'Not executed: no tools now.', isError: true })) });
      const saved = await appendLessons(host, parseLessons(messageText(response.message)), (file) => this.changes.recordBefore(file));
      if (!saved) return;
      this.changes.notify();
      this.emit({
        type: 'notice',
        level: 'info',
        message: t('Saved what this task taught about the project to {file}: {lessons}', { file: `${MEMORY_DIR}/${LESSONS_FILE}`, lessons: saved.added.join(' · ') }),
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      // Learning is a bonus: the request itself is done.
    }
  }

  /** The user's afterEdit hooks for a file an agent just changed; returns what the agent should know. */
  private async afterEditHooks(absPath: string, signal: AbortSignal): Promise<string> {
    const relPath = toRelative(this.options.host.workspaceRoot, absPath);
    const hooks = hooksForFile(this.options.getSettings().hooks?.afterEdit ?? [], relPath);
    if (!hooks.length) return '';
    const results = await this.runHooks('afterEdit', hooks, signal, relPath);
    if (!results.length) return '';
    return `\n\n${results.map((r) => describeHookResult('afterEdit', r)).join('\n')}\nThe hooks may have changed this file; read it again before editing it further.`;
  }

  /** Run hooks one after another, each shown in the chat like a command. */
  private async runHooks(point: 'afterEdit' | 'beforeFinish', hooks: readonly HookCommand[], signal: AbortSignal, relPath?: string): Promise<HookResult[]> {
    const results: HookResult[] = [];
    // Project-wide checks can change any file (e.g. "eslint --fix"): keep those changes revertible.
    const snapshots = point === 'beforeFinish' ? this.options.commandSnapshots : undefined;
    const before = snapshots ? await snapshots.snapshot() : undefined;
    for (const hook of hooks) {
      if (signal.aborted) break;
      const id = this.nextId('h');
      const title = (command: string) => t('Hook: {command}', { command: oneLine(command, 80) });
      const view: ToolCallView = { id, name: 'hook', title: title(hook.command), category: 'command', risk: 'normal', status: 'running', detail: `$ ${hook.command}` };
      this.setPhase('verifying');
      this.emit({ type: 'tool_call', call: view });
      const result = await runHook(this.options.host, hook, signal, relPath, (chunk) => this.emit({ type: 'tool_output', id, chunk }));
      const output = `${result.summary}${result.output ? `\n${result.output}` : ''}`;
      this.emit({ type: 'tool_call', call: { ...view, title: title(result.command), status: result.ok ? 'done' : signal.aborted ? 'cancelled' : 'error', output } });
      results.push(result);
    }
    if (before) await this.recordCommandChanges(snapshots!, before);
    return results;
  }

  /** Every tool call must get a result, or the next request is rejected. */
  private answerUnexecuted(calls: ToolCallBlock[], reason: string): void {
    if (!calls.length) return;
    for (const call of calls) this.emit({ type: 'tool_call', call: { ...this.placeholderView(call), status: 'cancelled', output: reason } });
    this.messages.push({
      role: 'user',
      content: calls.map((call) => ({ type: 'tool_result', toolCallId: call.id, content: reason, isError: true })),
    });
  }

  private verifyNudge(): string {
    const commands = this.context.verifyCommands;
    const hint = commands.length ? ` Likely commands for this project: ${commands.map((c) => `\`${c}\``).join(', ')}.` : '';
    return (
      '[Orchestrator check] You changed code in this task but have not run a build, type-check or test since the last change.' +
      `${hint} If the change can be verified, run the appropriate command now and fix any failures. ` +
      'If verification is not possible or not applicable here, say so in one sentence and finish.'
    );
  }

  private createSubagentTool(profiles: SubagentProfile[]): Tool<{ agent: string; task: string }> {
    const list = profiles.map((p) => `- ${p.name}${p.access === 'readonly' ? ' (read-only)' : ''}: ${p.description}`).join('\n');
    return {
      name: SUBAGENT_TOOL,
      description:
        'Delegate a self-contained task to a sub-agent and receive its final report. The sub-agent does not see this ' +
        'conversation, so the task must include everything it needs: goal, relevant files, constraints and what to report. ' +
        'Its file changes join the same change list and its actions follow the same permission rules. Several workers called in ' +
        'one reply run side by side in copies of the project and are merged afterwards; give them separate files. ' +
        `\nAvailable sub-agents:\n${list}`,
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: profiles.map((p) => p.name), description: 'Which sub-agent to use.' },
          task: { type: 'string', description: 'Complete, self-contained instructions for the sub-agent.' },
        },
        required: ['agent', 'task'],
      },
      // Delegating is harmless by itself; each action the sub-agent takes is permission-checked.
      describe: (input) => ({ category: 'read', risk: 'safe', title: `${input.agent}: ${oneLine(input.task, 90)}`, detail: input.task }),
      execute: (input, ctx) => this.runSubagent(input, ctx),
    };
  }

  private async runSubagent(input: { agent: string; task: string }, ctx: ToolContext) {
    const profile = this.taskProfiles.find((p) => p.name === input.agent);
    if (!profile) throw new ToolError(`Unknown sub-agent "${input.agent}".`);
    let provider: AIProvider;
    try {
      provider = this.options.subagents!.getProvider(profile.name);
    } catch (error) {
      throw new ToolError(`Sub-agent "${profile.name}" is not available: ${errorMessage(error)}`);
    }
    const settings = this.options.getSettings();
    // A worker of a side-by-side batch works in its own copy, with its own change list; its
    // changes are merged into the workspace after the batch (runWorkersSideBySide).
    const isolated = this.isolated.get(ctx.callId);
    const child = new Orchestrator({
      host: isolated ? hostAt(this.options.host, isolated.copy.dir) : this.options.host,
      getProvider: () => provider,
      permissions: this.options.permissions,
      getSettings: () => ({ ...this.options.getSettings(), autoVerify: false, maxIterations: profile.maxIterations ?? Math.min(settings.maxIterations, 40) }),
      tools: this.baseTools.filter((tool) => tool.name !== 'update_plan' && (profile.access === 'full' || READONLY_TOOLS.has(tool.name))),
      changes: isolated ? undefined : this.changes,
      role: profile,
      skills: () => this.taskSkills,
      getFallbackProvider: this.options.getFallbackProvider,
      commandSnapshots: isolated ? undefined : this.options.commandSnapshots,
      // MCP tools: all of them for workers, only the read-only ones for read-only sub-agents. Workers
      // in copies get none: the application an MCP server drives is shared, the copies are not.
      getExtraTools: async () => (isolated ? [] : profile.access === 'full' ? this.extraTools : this.extraTools.filter((tool) => tool.readOnly)),
    });
    child.on((event) => this.emit({ type: 'subagent', parentId: ctx.callId, agent: profile.name, event }));
    // The secrets guard spans the whole task: what one agent read, no agent may quietly send out.
    child.secretFile = this.secretFile;
    const stopChild = () => child.stop();
    ctx.signal.addEventListener('abort', stopChild, { once: true });
    try {
      const reason = await child.run(isolated ? `${input.task}\n\n${ISOLATED_WORKER_NOTE}` : input.task);
      this.secretFile ??= child.secretFile;
      if (isolated) isolated.changes = await isolated.copy.changes().catch(() => []);
      const own = child.usageByAgent.find((u) => u.agent === profile.name);
      if (own) this.recordUsage(profile.name, own.provider, own.model, own.usage, own.calls);
      this.emitUsage();
      const last = [...child.history].reverse().find((m) => m.role === 'assistant');
      const report = last ? messageText(last).trim() : '';
      const header = `[${profile.name} sub-agent report - ${provider.label} ${provider.model}]`;
      switch (reason) {
        case 'stopped':
          return { content: `${header}\nThe sub-agent was stopped by the user.`, isError: true };
        case 'error':
          return { content: `${header}\nThe sub-agent failed: ${child.lastError ?? 'unknown error'}`, isError: true };
        case 'refusal':
          return { content: `${header}\nThe sub-agent's model declined the task.`, isError: true };
        case 'max_iterations':
          return { content: `${header}\n${report || '(no report)'}\n\n(The sub-agent hit its step limit; this report may be incomplete.)` };
        case 'budget':
          return { content: `${header}\n${report || '(no report)'}\n\n(The sub-agent hit the token budget; this report may be incomplete.)` };
        default:
          return { content: `${header}\n${report || '(the sub-agent finished without a report)'}` };
      }
    } finally {
      ctx.signal.removeEventListener('abort', stopChild);
      child.dispose();
    }
  }

  private forwardStreamEvent(assistantId: string, event: ProviderStreamEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.emit({ type: 'assistant_delta', id: assistantId, text: event.text });
        break;
      case 'reasoning_delta':
        this.emit({ type: 'reasoning_delta', id: assistantId, text: event.text });
        break;
      case 'notice':
        this.emit({ type: 'notice', level: 'info', message: event.message });
        break;
      case 'tool_call_start':
        break;
    }
  }

  private placeholderView(call: ToolCallBlock): ToolCallView {
    return { id: call.id, name: call.name, title: call.name, category: 'read', risk: 'safe', status: 'running' };
  }

  private async publishChanges(): Promise<void> {
    try {
      this.emit({ type: 'changes', changes: await this.changes.list() });
    } catch {
      /* listing is best-effort */
    }
  }

  private currentPhase: AgentPhase = 'idle';
  private setPhase(phase: AgentPhase): void {
    if (phase === this.currentPhase) return;
    this.currentPhase = phase;
    this.emit({ type: 'phase', phase });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken UI listener must not break the agent */
      }
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}${Date.now().toString(36)}${(this.idCounter++).toString(36)}`;
  }
}

function phaseFor(toolName: string, category: ToolAction['category']): AgentPhase {
  if (toolName === SUBAGENT_TOOL) return 'delegating';
  if (toolName === 'update_plan') return 'planning';
  if (toolName === 'run_command' || toolName === 'start_process') return 'verifying';
  if (category === 'edit' || category === 'delete') return 'implementing';
  return 'analyzing';
}

function targetPath(root: string, input: Record<string, unknown>): string | undefined {
  return typeof input.path === 'string' && input.path ? path.resolve(root, input.path) : undefined;
}

function abortPromise(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(undefined);
    else signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const COMPACT_REQUEST = `[Orchestrator] This conversation is getting long and will now be compacted. Write a handoff note for yourself that will replace everything above. Do not call any tools - reply with the note only.

Include, specifically:
- the user's goal and constraints (quote exact requirements);
- decisions made so far and why;
- what has been done: files, functions, commands, with their current state;
- verification status: what was built or tested, what passed, what failed and the key error lines;
- open problems and the concrete next steps;
- anything the user or the supervisor asked that still applies.

Be complete but compact (at most about 800 words).`;

const ISOLATED_WORKER_NOTE = `[Orka] You work in your own copy of the project, side by side with other workers; your changes are merged into the real workspace when you finish. Dependency and build folders (node_modules, Library, obj, build output) and git are not in this copy, so do not try to build, test or use git here: make the change, check it by reading the code, and say in your report what should be built or tested. Stay within the files your task names, so your work does not collide with the other workers'.`;

/** The same host, rooted in another folder (a worker's copy of the workspace). */
function hostAt(host: Host, root: string): Host {
  return new Proxy(host, {
    get(target, prop) {
      if (prop === 'workspaceRoot') return root;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const LESSONS_REQUEST =`[Orchestrator] The request is done. Is there anything from it a future session in this project should know? List at most 3 durable, project-specific lessons: for example the build or test command that works, a pitfall and how to avoid it, or a convention or decision the user confirmed. Only facts that stay true - not what you did in this task, not general programming advice, nothing already in the project memory. One short line each, starting with "- ". If there is nothing worth keeping, reply with exactly NONE. Do not call tools; do not repeat your answer to the user.`;

/** An external agent's error that means it is not signed in (wording differs per agent). */
const AUTH_FAILURE = /not (logged|signed) in|\b(log ?in|sign ?in|authenticat\w*|auth)\b[^.\n]{0,40}\b(required|needed|missing|expired)\b|\bunauthori[sz]ed\b/i;

/** Notes from the agent's previous turn (declined actions, hook results) ahead of its next prompt. */
function withNotes(notes: readonly string[], text: string): string {
  if (!notes.length) return text;
  return `[Orka] Notes from your previous turn:\n${notes.map((n) => `- ${n}`).join('\n')}\n\n${text}`;
}

/** An external agent's turn in the history: its answer and what it did, as plain text any model can read. */
function agentTurnText(label: string, text: string, activity: readonly string[], files: readonly string[]): string {
  const lines = [text || '(no answer)'];
  if (activity.length || files.length) {
    lines.push('', `<agent_activity agent="${label}">`, ...activity.slice(-ACTIVITY_LINES));
    if (files.length) lines.push(`- files changed: ${files.slice(0, 30).join(', ')}`);
    lines.push('</agent_activity>');
  }
  return lines.join('\n');
}

/** What the agent is told when the user's beforeFinish checks fail. */
function hookFailureText(failed: readonly HookResult[]): string {
  return [
    '[Orchestrator] The project checks the user configured as hooks failed, so the task is not done yet:',
    ...failed.map((r) => describeHookResult('beforeFinish', r)),
    'Fix the problems, then finish. If a failure is unrelated to this task and cannot be fixed here, say so in one sentence and finish.',
  ].join('\n\n');
}

/** Rough token estimate (4 characters per token) for messages we have not sent yet. */
function estimateTokens(messages: readonly ChatMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/** Map with at most limit promises in flight; results keep the input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The secret-looking file a read / search / command touched, if any (workspace-relative). */
function secretTouched(call: ToolCallBlock): string | undefined {
  const input = call.input;
  if (call.name === 'read_file' && typeof input.path === 'string' && SECRET_FILE.test(input.path)) return input.path;
  if (call.name === 'run_command' && typeof input.command === 'string') {
    const match = secretInCommand(input.command);
    if (match) return match;
  }
  if (call.name === 'search_code' && typeof input.glob === 'string' && /\.env|secret|credential|\.pem|\.key/i.test(input.glob)) return input.glob;
  return undefined;
}

/** A plan's structure (step titles), to tell a new or revised plan from progress updates. */
function planShape(plan: Plan | undefined): string {
  return plan ? plan.steps.map((s) => s.title).join('\n') : '';
}

/** Why the agent looks stuck, from its recent tool outcomes (undefined when it does not). */
function stuckReason(recent: Array<{ key: string; error: boolean }>): string | undefined {
  const last = recent.slice(-3);
  if (last.length === 3 && last.every((r) => r.error)) return t('the last 3 tool calls failed');
  const lastTwo = recent.slice(-2);
  if (lastTwo.length === 2 && lastTwo[0].key === lastTwo[1].key && lastTwo.every((r) => r.error)) return t('the same action failed twice');
  const counts = new Map<string, number>();
  for (const r of recent.slice(-6)) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  if ([...counts.values()].some((n) => n >= 3)) return t('the same action keeps being repeated');
  return undefined;
}

function argSummary(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}=${oneLine(typeof v === 'string' ? v : JSON.stringify(v) ?? '', k === 'command' || k === 'path' || k === 'query' ? 120 : 40)}`)
    .join(', ');
}

/** Tokens that count against a budget: everything except cache reads. */
function spent(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens;
}

function rank(agent: string): number {
  return agent === 'main' ? 0 : agent === 'supervisor' ? 1 : 2;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
