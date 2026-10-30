import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChangeTracker } from '../changes/ChangeTracker';
import { splitLines } from '../changes/diff';
import type { ApprovalRequest, Host } from '../host/Host';
import { t } from '../i18n';
import type { AgentEvent, ToolCallView } from '../orchestrator/events';
import { classifyCommand } from '../permissions/commandRisk';
import type { PermissionManager } from '../permissions/PermissionManager';
import { isSecretFile } from '../permissions/secrets';
import type { Plan } from '../planning/Plan';
import { JsonRpcError, RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS } from '../rpc/JsonRpcStdio';
import { toRelative } from '../tools/workspace';
import type { AcpClient, AcpSessionHandlers } from './AcpClient';
import { AcpTurnMapper, isInside, safeId } from './mapping';
import { AcpTerminals, commandLine } from './terminals';
import {
  ACP_RESOURCE_NOT_FOUND,
  type ContentBlock,
  type CreateTerminalParams,
  type PermissionOption,
  type PermissionOutcome,
  type ReadTextFileParams,
  type RequestPermissionParams,
  type StopReason,
  type WriteTextFileParams,
} from './types';

/** What a session needs from the task it belongs to (the orchestrator provides it). */
export interface AcpSessionContext {
  host: Host;
  permissions: PermissionManager;
  changes: ChangeTracker;
  emit(event: AgentEvent): void;
  setPlan(plan: Plan): void;
  /** A new unique id for transcript items. */
  nextId(prefix: string): string;
  /** The user's afterEdit hooks for a file the agent wrote; returns what the agent should be told ('' when none ran). */
  afterEdit(absPath: string, signal: AbortSignal): Promise<string>;
  /** The task's secrets guard: the secret-looking file read so far, if any. */
  secretFile(): string | undefined;
  noteSecret(relPath: string): void;
  /** The agent's name ("Gemini CLI"). */
  label: string;
  /** Longest run of one terminal command. */
  commandTimeoutMs: number;
}

/** How a prompt turn went. */
export interface AcpTurnResult {
  stopReason: StopReason;
  /** Everything the agent wrote. */
  text: string;
  /** Its last answer bubble. */
  lastText: string;
  /** One line per finished tool call. */
  activity: string[];
  changedCode: boolean;
  /** It ran a command after its last change (so the change was checked). */
  ranCommandAfterChange: boolean;
}

/** How long a cancelled turn may take to end before the agent's process is stopped. */
const CANCEL_GRACE_MS = 5_000;
const MAX_CARD_OUTPUT = 20_000;

interface Turn {
  mapper: AcpTurnMapper;
  signal: AbortSignal;
  /**
   * What the agent's own permission requests got approved in this turn, so carrying them out
   * through Orka does not ask twice: exact command lines, and files with the content the approval
   * showed (undefined: the request showed no content, any content is what was approved).
   */
  approvedCommands: Set<string>;
  approvedWrites: Map<string, string | undefined>;
  ownCards: number;
}

type Approval = 'awaiting' | 'allowed' | 'cancelled' | { denied: string };

/**
 * One ACP session bound to one Orka task. It sends the task's prompts and answers the agent's
 * requests the way Orka treats its own tools: permission requests go through the permission
 * rules and the user's approval, file reads and writes stay inside the workspace and writes land
 * in the change list (keep / revert), terminal commands run in the host's shell after approval.
 *
 * What the agent does with its own tools, without asking, cannot be gated here; the orchestrator
 * snapshots the workspace around every prompt so those changes are listed and revertible too.
 */
export class AcpAgentSession {
  sessionId?: string;
  private turns = 0;
  private current?: Turn;
  /** For the agent with its next prompt: what the user said when declining, hook results. */
  private notes: string[] = [];
  private readonly terminals: AcpTerminals;

  constructor(
    readonly client: AcpClient,
    private readonly ctx: AcpSessionContext,
  ) {
    this.terminals = new AcpTerminals(ctx.host, ctx.commandTimeoutMs);
  }

  private get root(): string {
    return this.ctx.host.workspaceRoot;
  }

  /** Open the session in the workspace. */
  async start(): Promise<void> {
    this.sessionId = await this.client.newSession(this.root, this.handlers());
  }

  /** The agent accepts images in prompts. */
  get acceptsImages(): boolean {
    return !!this.client.init?.agentCapabilities?.promptCapabilities?.image;
  }

  /** Notes for the agent's next prompt (and forget them). */
  takeNotes(): string[] {
    const notes = this.notes;
    this.notes = [];
    return notes;
  }

  /**
   * Send one prompt and wait for the agent's turn to end. Aborting `signal` cancels the turn:
   * session/cancel, open approvals answered "cancelled", terminals stopped, and the process is
   * stopped if the turn has not ended within 5 seconds.
   */
  async prompt(blocks: ContentBlock[], signal: AbortSignal): Promise<AcpTurnResult> {
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error('The ACP session was not started.');
    const turnNumber = ++this.turns;
    const mapper = new AcpTurnMapper(
      { emit: this.ctx.emit, setPlan: this.ctx.setPlan, nextId: this.ctx.nextId, root: this.root, label: this.ctx.label },
      `acp_${safeId(sessionId).slice(-16)}_${turnNumber}_${this.ctx.nextId('')}_`,
    );
    const turn: Turn = { mapper, signal, approvedCommands: new Set(), approvedWrites: new Map(), ownCards: 0 };
    this.current = turn;
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      this.terminals.killAll();
      killTimer = setTimeout(() => this.client.close(), CANCEL_GRACE_MS);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let stopReason: StopReason = 'cancelled';
    try {
      stopReason = await this.client.prompt(sessionId, blocks, signal);
    } catch (error) {
      // Stopped after the grace period: the process is gone, the turn is over.
      if (!signal.aborted) throw error;
    } finally {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) stopReason = 'cancelled';
      mapper.finish(stopReason);
      this.current = undefined;
    }
    return {
      stopReason,
      text: mapper.text,
      lastText: mapper.lastText,
      activity: [...mapper.activity],
      changedCode: mapper.changedCode,
      ranCommandAfterChange: mapper.ranCommandAfterChange,
    };
  }

  /** The task is done with this session (new task, rewind, another agent). */
  dispose(): void {
    this.terminals.killAll();
    if (this.sessionId) this.client.forgetSession(this.sessionId);
  }

  private handlers(): AcpSessionHandlers {
    return {
      update: (update) => this.current?.mapper.handle(update),
      requestPermission: (params) => this.requestPermission(params),
      readTextFile: (params) => this.readTextFile(params),
      writeTextFile: (params) => this.writeTextFile(params),
      createTerminal: (params) => this.createTerminal(params),
      terminalOutput: (params) => this.terminals.output(params.terminalId),
      waitForTerminalExit: (params) => this.terminals.waitForExit(params.terminalId),
      killTerminal: (params) => this.terminals.kill(params.terminalId),
      releaseTerminal: (params) => this.terminals.release(params.terminalId),
    };
  }

  /**
   * The agent asks before one of its own tool calls. Orka decides with its own rules and asks the
   * user when they say so, and always answers "once": an "always allow" from the user becomes
   * Orka's own session grant, so the decision stays with Orka.
   */
  private async requestPermission(params: RequestPermissionParams): Promise<PermissionOutcome> {
    const turn = this.current;
    if (!turn || turn.signal.aborted) return { outcome: 'cancelled' };
    const state = turn.mapper.tool(params.toolCall);
    if (!state) return { outcome: 'cancelled' };
    const action = turn.mapper.actionOf(state);
    const view = turn.mapper.viewOf(state);
    // Once the task has read a secret-looking file, nothing goes to the internet unseen.
    const guard = action.category === 'network' && !!this.ctx.secretFile();
    const request: ApprovalRequest = {
      id: view.id,
      toolName: view.name,
      category: action.category,
      risk: action.risk,
      title: view.title,
      detail: guard ? [view.detail, t('Asking because this task has read a file that may contain secrets ({file}).', { file: this.ctx.secretFile()! })].filter(Boolean).join('\n') : view.detail,
      preview: turn.mapper.previewOf(state),
    };
    const answer = await this.authorize(turn, request, action.alwaysAsk || guard, (approval) => turn.mapper.setApproval(state, approval));
    if (answer === 'cancelled') return { outcome: 'cancelled' };
    if (answer === 'allow') {
      if (action.command) turn.approvedCommands.add(action.command.trim());
      if (action.category === 'edit') {
        const preview = request.preview;
        if (preview) turn.approvedWrites.set(pathKey(preview.path), preview.after ?? undefined);
        for (const p of state.locations) if (!turn.approvedWrites.has(pathKey(p))) turn.approvedWrites.set(pathKey(p), undefined);
      }
      if (action.category === 'read') for (const p of state.locations) if (isSecretFile(p)) this.ctx.noteSecret(toRelative(this.root, p));
    }
    return choose(params.options, answer === 'allow');
  }

  /** Orka's permission rules, then the user's approval when they say so. */
  private async authorize(turn: Turn, request: ApprovalRequest, forceAsk: boolean, show: (approval: Approval) => void): Promise<'allow' | 'deny' | 'cancelled'> {
    let decision = this.ctx.permissions.decide(request);
    if (forceAsk && decision === 'allow') decision = 'ask';
    if (decision === 'deny') {
      show({ denied: 'Denied by permission settings.' });
      return 'deny';
    }
    if (decision === 'allow') {
      show('allowed');
      return 'allow';
    }
    show('awaiting');
    const answer = await Promise.race([this.ctx.host.requestApproval(request), abortPromise(turn.signal)]);
    if (!answer || turn.signal.aborted) {
      show('cancelled');
      return 'cancelled';
    }
    if (!answer.approved) {
      const feedback = answer.feedback?.trim();
      this.notes.push(`The user declined "${request.title}".${feedback ? ` User feedback: ${feedback}` : ' Do not retry it unchanged; adjust your approach or ask the user.'}`);
      show({ denied: feedback ? `Declined: ${feedback}` : 'Declined' });
      return 'deny';
    }
    // What always asks (mode switches, paths outside the workspace) is never granted for the session:
    // "always allow" on a mode switch must not quietly allow every dangerous command after it.
    if (answer.alwaysAllow && !forceAsk) this.ctx.permissions.grantForSession(request);
    show('allowed');
    return 'allow';
  }

  /** fs/read_text_file: a file inside the workspace (optionally a range of lines). */
  private async readTextFile(params: ReadTextFileParams): Promise<{ content: string }> {
    const abs = await this.workspacePath(params.path);
    const rel = toRelative(this.root, abs);
    const host = this.ctx.host;
    if (!(await host.exists(abs)) || (await host.isDirectory(abs))) throw new JsonRpcError(`File not found: ${rel}`, ACP_RESOURCE_NOT_FOUND);
    if (isSecretFile(rel)) this.ctx.noteSecret(rel);
    const text = await host.readFile(abs);
    if (params.line == null && params.limit == null) return { content: text };
    const start = Math.max(0, Math.floor(Number(params.line ?? 1)) - 1);
    const limit = params.limit == null ? undefined : Math.max(0, Math.floor(Number(params.limit)));
    return { content: splitLines(text).slice(start, limit === undefined ? undefined : start + limit).join('') };
  }

  /**
   * fs/write_text_file: inside the workspace, approved by Orka's rules (unless the agent's own
   * request for this call was just approved), recorded in the change list before it is written,
   * then the user's afterEdit hooks.
   */
  private async writeTextFile(params: WriteTextFileParams): Promise<void> {
    const turn = this.current;
    if (!turn || turn.signal.aborted) throw new JsonRpcError('The user stopped the agent; nothing was written.', RPC_INTERNAL_ERROR);
    const abs = await this.workspacePath(params.path);
    const rel = toRelative(this.root, abs);
    const host = this.ctx.host;
    if (await host.isDirectory(abs)) throw new JsonRpcError(`${rel} is a folder.`, RPC_INVALID_PARAMS);
    const before = (await host.exists(abs)) ? await host.readFile(abs) : null;
    if (before === params.content) return;
    const title = before === null ? t('Create {path}', { path: rel }) : t('Edit {path}', { path: rel });
    const call = turn.mapper.callForPath(abs);
    const cardId = call?.cardId ?? `${turn.mapper.prefix}w${++turn.ownCards}`;
    if (!call) turn.mapper.showCard({ id: cardId, name: 'acp:write', title, category: 'edit', risk: 'normal', status: 'running', path: abs });
    // Approved content only: an approval that showed one change does not cover writing another.
    const key = pathKey(abs);
    const approved = turn.approvedWrites.has(key) && [undefined, params.content].includes(turn.approvedWrites.get(key));
    if (!approved) {
      const request: ApprovalRequest = { id: cardId, toolName: 'acp:write', category: 'edit', risk: 'normal', title, preview: { path: abs, before, after: params.content } };
      const answer = await this.authorize(turn, request, false, (approval) => (call ? turn.mapper.setApproval(call, approval) : turn.mapper.patchCard(cardId, cardStatus(approval))));
      if (answer === 'cancelled') throw new JsonRpcError('The user stopped the agent; nothing was written.', RPC_INTERNAL_ERROR);
      if (answer === 'deny') throw new JsonRpcError(`Not written: the user declined writing ${rel}.`, RPC_INTERNAL_ERROR);
    }
    await this.ctx.changes.recordBefore(abs);
    await host.writeFile(abs, params.content);
    this.ctx.changes.notify();
    turn.mapper.noteWrite(abs);
    if (!call) turn.mapper.patchCard(cardId, { status: 'done' });
    const hooks = (await this.ctx.afterEdit(abs, turn.signal).catch(() => '')).trim();
    if (hooks) this.notes.push(`After you wrote ${rel}, the user's hooks ran:\n${hooks}`);
  }

  /**
   * terminal/create: a command in the host's shell, inside the workspace, approved like Orka's
   * own run_command (unless the agent's request for this call was just approved). The agent's env
   * is not applied: the command runs with the environment Orka's own commands get.
   */
  private async createTerminal(params: CreateTerminalParams): Promise<{ terminalId: string }> {
    const turn = this.current;
    if (!turn || turn.signal.aborted) throw new JsonRpcError('No prompt is running, so no command can start.', RPC_INTERNAL_ERROR);
    const cwd = params.cwd ? await this.workspacePath(params.cwd) : this.root;
    if (!(await this.ctx.host.isDirectory(cwd))) throw new JsonRpcError(`Not a folder: ${toRelative(this.root, cwd)}`, RPC_INVALID_PARAMS);
    const line = commandLine(params.command, params.args ?? [], this.ctx.host.shellName);
    const risk = classifyCommand(line, { workspaceRoot: this.root, cwd });
    const title = t('Run: {command}', { command: oneLine(line, 80) });
    const detail = [`$ ${line}`, cwd !== this.root ? t('in {cwd}', { cwd: toRelative(this.root, cwd) }) : '', risk.reason ? t('Risk: {reason}', { reason: t(risk.reason) }) : '']
      .filter(Boolean)
      .join('\n');
    const call = turn.mapper.callForCommand(line);
    const cardId = call?.cardId ?? `${turn.mapper.prefix}t${++turn.ownCards}`;
    if (!call) turn.mapper.showCard({ id: cardId, name: 'acp:terminal', title, category: risk.category, risk: risk.risk, status: 'running', detail });
    // Only the exact command line the user saw counts as approved.
    if (!turn.approvedCommands.has(line.trim())) {
      const request: ApprovalRequest = { id: cardId, toolName: 'acp:terminal', category: risk.category, risk: risk.risk, title, detail };
      const answer = await this.authorize(turn, request, false, (approval) => (call ? turn.mapper.setApproval(call, approval) : turn.mapper.patchCard(cardId, cardStatus(approval))));
      if (answer === 'cancelled') throw new JsonRpcError('The user stopped the agent; the command did not run.', RPC_INTERNAL_ERROR);
      if (answer === 'deny') throw new JsonRpcError('Not run: the user declined this command.', RPC_INTERNAL_ERROR);
    }
    const terminalId = this.terminals.start(
      line,
      cwd,
      params.outputByteLimit,
      (chunk) => this.ctx.emit({ type: 'tool_output', id: turn.mapper.terminalCard(terminalId) ?? cardId, chunk }),
      (status, output) => {
        turn.mapper.noteCommand();
        if (!call) turn.mapper.patchCard(cardId, { status: status.exitCode === 0 ? 'done' : 'error', output: tail(output) || undefined });
      },
    );
    turn.mapper.linkTerminal(terminalId, cardId);
    return { terminalId };
  }

  /**
   * A path the agent named, as an absolute path inside the workspace. Paths outside it, and links
   * inside it that lead outside it, are refused.
   */
  private async workspacePath(input: string): Promise<string> {
    const root = this.root;
    const abs = path.resolve(root, input);
    const refuse = () => new JsonRpcError(`Orka only lets agents use files inside the workspace (${root}); ${input} is outside it.`, RPC_INVALID_PARAMS);
    if (!isInside(root, abs)) throw refuse();
    const realRoot = await fs.realpath(root).catch(() => root);
    let probe = abs;
    while (!(await exists(probe)) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const real = await fs.realpath(probe).catch(() => probe);
    if (!isInside(realRoot, real)) throw refuse();
    return abs;
  }
}

/** Orka answers "once" so the next request asks Orka again; without such an option, the request is cancelled. */
function choose(options: readonly PermissionOption[], allow: boolean): PermissionOutcome {
  const kinds = allow ? ['allow_once'] : ['reject_once', 'reject_always'];
  for (const kind of kinds) {
    const option = options.find((o) => o && o.kind === kind && typeof o.optionId === 'string');
    if (option) return { outcome: 'selected', optionId: option.optionId };
  }
  return { outcome: 'cancelled' };
}

function cardStatus(approval: Approval): Partial<ToolCallView> {
  if (approval === 'awaiting') return { status: 'awaiting_approval', hasPreview: true };
  if (approval === 'allowed') return { status: 'running' };
  if (approval === 'cancelled') return { status: 'cancelled' };
  return { status: 'denied', output: approval.denied };
}

function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function abortPromise(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(undefined);
    else signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });
}

function tail(text: string): string {
  return text.length > MAX_CARD_OUTPUT ? `…${text.slice(-MAX_CARD_OUTPUT)}` : text;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
