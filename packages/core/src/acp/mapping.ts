import * as path from 'node:path';
import { unifiedDiff } from '../changes/diff';
import { t } from '../i18n';
import type { AgentEvent, ToolCallStatus as CardStatus, ToolCallView } from '../orchestrator/events';
import { classifyCommand } from '../permissions/commandRisk';
import type { PermissionCategory, RiskLevel } from '../permissions/PermissionManager';
import { isSecretFile, secretInCommand } from '../permissions/secrets';
import type { Plan, PlanStepStatus } from '../planning/Plan';
import { toRelative } from '../tools/workspace';
import type { ContentBlock, SessionUpdate, StopReason, ToolCallContent, ToolCallFields, ToolKind } from './types';

/** How Orka's permission rules see one of the agent's tool calls. */
export interface AcpAction {
  category: PermissionCategory;
  risk: RiskLevel;
  /** Why a command is risky (a risk-reason key, translated for display). */
  reason?: string;
  /** The command line of an execute call, when the agent said it. */
  command?: string;
  /** Paths the call touches outside the workspace. */
  outside: string[];
  /** Ask the user whatever the permission mode says (mode switches, paths outside the workspace). */
  alwaysAsk: boolean;
}

const TOOL_KINDS = new Set<ToolKind>(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const EDIT_KINDS = new Set<ToolKind>(['edit', 'delete', 'move']);
const NON_CODE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.rst']);
const MAX_OUTPUT = 20_000;
const ACTIVITY_LINES = 30;

/**
 * Orka's permission category and risk for an ACP tool kind: read/search/think are reads, edit and
 * move are edits, execute is a command classified like Orka's own run_command (with the git risk
 * of the repository's config, `gitRisk`, and the working directory it names), fetch is network.
 * An execute call whose command Orka cannot read is dangerous; any other unknown kind is a normal
 * command.
 */
export function actionFor(kind: ToolKind, rawInput: unknown, locations: readonly string[], root: string, context: { gitRisk?: string } = {}): AcpAction {
  const outside = locations.filter((p) => !isInside(root, p));
  const base = { outside, alwaysAsk: outside.length > 0 };
  switch (kind) {
    case 'read':
    case 'search':
    case 'think':
      return { ...base, category: 'read', risk: 'safe' };
    case 'edit':
    case 'move':
      return { ...base, category: 'edit', risk: outside.length ? 'dangerous' : 'normal' };
    case 'delete':
      return { ...base, category: 'delete', risk: outside.length ? 'dangerous' : 'normal' };
    case 'execute': {
      const command = commandOf(rawInput);
      // Nobody knows what it runs: the user sees its raw input and decides.
      if (!command) return { ...base, category: 'command', risk: 'dangerous', reason: 'a command Orka cannot read' };
      const dir = cwdOf(rawInput);
      const cwd = dir === undefined ? root : path.resolve(root, dir);
      const c = classifyCommand(command, { workspaceRoot: root, cwd, gitRisk: context.gitRisk });
      // A command that runs in a folder outside the workspace always asks, like a path outside it.
      const all = isInside(root, cwd) ? outside : [...outside, cwd];
      return { outside: all, alwaysAsk: all.length > 0, category: c.category, risk: c.risk, reason: c.reason, command };
    }
    case 'fetch':
      return { ...base, category: 'network', risk: 'normal' };
    case 'switch_mode':
      // A mode switch can turn the agent's own approvals off: the user decides, every time.
      return { ...base, category: 'command', risk: 'dangerous', alwaysAsk: true };
    default:
      return { ...base, category: 'command', risk: 'normal' };
  }
}

/**
 * The command line in an execute call's raw input: a string, `{command: "..."}`, or an argv
 * array (`["bash", "-lc", "npm test"]` is the script itself).
 */
export function commandOf(rawInput: unknown): string | undefined {
  const value =
    typeof rawInput === 'string' || Array.isArray(rawInput)
      ? rawInput
      : rawInput && typeof rawInput === 'object'
        ? ((rawInput as Record<string, unknown>).command ?? (rawInput as Record<string, unknown>).cmd)
        : undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string') && value.length) {
    const [program, flag, script] = value as string[];
    if (value.length === 3 && /^(ba|z|da)?sh$|^pwsh$|^powershell$|^cmd$/i.test(path.basename(program).replace(/\.exe$/i, '')) && /^(-l?c|-Command|\/c)$/i.test(flag)) return script;
    return (value as string[]).join(' ');
  }
  return undefined;
}

/** The working directory an execute call's raw input names (`cwd`, `workdir` or `directory`), if any. */
export function cwdOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return undefined;
  const input = rawInput as Record<string, unknown>;
  const value = input.cwd ?? input.workdir ?? input.directory;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export interface MapperContext {
  emit(event: AgentEvent): void;
  setPlan(plan: Plan): void;
  /** A new unique id for transcript items. */
  nextId(prefix: string): string;
  root: string;
  /** The agent's name, shown as the "model" of its answers. */
  label: string;
  /** Why the repository's git config makes git run programs, if it does (see gitConfigRisk). */
  gitRisk?(): string | undefined;
  /** A tool call the agent reports as running or done touched a secret-looking file (workspace-relative). */
  noteSecret?(relPath: string): void;
}

export interface ToolState {
  cardId: string;
  kind: ToolKind;
  title: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations: string[];
  content: ToolCallContent[];
  status: CardStatus;
  /** Its card is waiting for the user's approval (set by the permission bridge). */
  awaiting: boolean;
  /** Set by the permission bridge when the user declined or the rules denied it. */
  denied?: string;
  ended: boolean;
}

/**
 * Turns one prompt turn's session/update notifications into Orka's AgentEvents, so the existing
 * transcript cards show the agent's answer, reasoning, tool calls and plan. Card ids carry the
 * ACP session, the turn and a unique stamp: after a rewind a fresh session may number its tool
 * calls from 1 again, and must not overwrite older cards.
 */
export class AcpTurnMapper {
  /** Everything the agent wrote in this turn. */
  text = '';
  /** The last answer bubble's text (what the agent said at the end). */
  lastText = '';
  /** One line per finished tool call, for the supervisor and the history. */
  readonly activity: string[] = [];
  /** It changed code (not just docs) in this turn. */
  changedCode = false;
  private seq = 0;
  private lastEdit = 0;
  private lastCommand = 0;
  private bubble?: { id: string; text: string };
  private readonly tools = new Map<string, ToolState>();
  private readonly cards = new Map<string, ToolCallView>();
  private readonly terminalCards = new Map<string, string>();

  constructor(
    private readonly ctx: MapperContext,
    /** Prefix of this turn's card ids. */
    readonly prefix: string,
  ) {}

  /** It ran a command after its last change (the change was checked). */
  get ranCommandAfterChange(): boolean {
    return this.lastCommand > this.lastEdit;
  }

  handle(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = blockText(update.content);
        if (!text) return;
        const bubble = this.openBubble();
        bubble.text += text;
        this.text += text;
        this.ctx.emit({ type: 'assistant_delta', id: bubble.id, text });
        return;
      }
      case 'agent_thought_chunk': {
        const text = blockText(update.content);
        if (text) this.ctx.emit({ type: 'reasoning_delta', id: this.openBubble().id, text });
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (update.sessionUpdate === 'tool_call') this.closeBubble();
        const state = this.tool(update);
        // A call that ran (as the agent reports it) on a secret-looking file turns the secrets guard on.
        const secret = state && (update.status === 'in_progress' || update.status === 'completed') ? this.secretOf(state) : undefined;
        if (secret) this.ctx.noteSecret?.(secret);
        return;
      }
      case 'plan': {
        if (!Array.isArray(update.entries)) return;
        const steps = update.entries
          .filter((e) => e && typeof e.content === 'string')
          .map((e) => ({ title: e.content, status: (['pending', 'in_progress', 'completed'].includes(e.status) ? e.status : 'pending') as PlanStepStatus }));
        this.ctx.setPlan({ steps });
        return;
      }
      default:
        // Commands, modes and context usage are not shown in this version.
        return;
    }
  }

  /** Create or update the card of one of the agent's tool calls; returns its state. */
  tool(fields: ToolCallFields): ToolState | undefined {
    const toolCallId = typeof fields.toolCallId === 'string' ? fields.toolCallId : '';
    if (!toolCallId) return undefined;
    let state = this.tools.get(toolCallId);
    if (!state) {
      state = { cardId: `${this.prefix}${safeId(toolCallId)}`, kind: 'other', title: '', locations: [], content: [], status: 'running', awaiting: false, ended: false };
      // A terminal the agent created before announcing the call already has a card: keep using it.
      const terminal = (fields.content ?? []).find((c) => c?.type === 'terminal') as { terminalId: string } | undefined;
      const own = terminal && this.terminalCards.get(terminal.terminalId);
      if (own && ![...this.tools.values()].some((s) => s.cardId === own)) state.cardId = own;
      this.tools.set(toolCallId, state);
    }
    if (fields.kind && TOOL_KINDS.has(fields.kind)) state.kind = fields.kind;
    if (typeof fields.title === 'string' && fields.title.trim()) state.title = fields.title.trim();
    if (fields.rawInput !== undefined && fields.rawInput !== null) state.rawInput = fields.rawInput;
    if (fields.rawOutput !== undefined && fields.rawOutput !== null) state.rawOutput = fields.rawOutput;
    if (Array.isArray(fields.locations)) state.locations = fields.locations.filter((l) => l && typeof l.path === 'string').map((l) => path.resolve(this.ctx.root, l.path));
    if (Array.isArray(fields.content)) {
      state.content = fields.content.filter((c) => c && typeof c === 'object');
      for (const c of state.content) if (c.type === 'terminal' && typeof c.terminalId === 'string' && !this.terminalCards.has(c.terminalId)) this.terminalCards.set(c.terminalId, state.cardId);
    }
    if (fields.status && !state.ended) {
      if (fields.status === 'completed' || fields.status === 'failed') this.end(state, fields.status === 'completed');
      else if (!state.awaiting && !state.denied) state.status = 'running';
    }
    this.emitTool(state);
    return state;
  }

  /** The permission bridge's view of a call: waiting for the user, or declined. */
  setApproval(state: ToolState, approval: 'awaiting' | 'allowed' | 'cancelled' | { denied: string }): void {
    state.awaiting = approval === 'awaiting';
    if (approval === 'awaiting') state.status = 'awaiting_approval';
    else if (approval === 'allowed') state.status = state.ended ? state.status : 'running';
    else if (approval === 'cancelled') state.status = 'cancelled';
    else {
      state.denied = approval.denied;
      state.status = 'denied';
    }
    this.emitTool(state);
  }

  /** How Orka's permission rules see a call. */
  actionOf(state: ToolState): AcpAction {
    return actionFor(state.kind, state.rawInput, [...state.locations, ...diffPaths(state.content, this.ctx.root)], this.ctx.root, { gitRisk: this.ctx.gitRisk?.() });
  }

  /**
   * The secret-looking file a call touches, if any (workspace-relative), read the way Orka's own
   * secrets guard reads its tools: a location or diff path, or a command's argument.
   */
  secretOf(state: ToolState): string | undefined {
    const file = [...state.locations, ...diffPaths(state.content, this.ctx.root)].find((p) => isSecretFile(p));
    if (file) return toRelative(this.ctx.root, file);
    const command = state.kind === 'execute' ? commandOf(state.rawInput) : undefined;
    return command ? secretInCommand(command) : undefined;
  }

  /** The proposed change of an edit call, for the approval diff. */
  previewOf(state: ToolState): { path: string; before: string | null; after: string | null } | undefined {
    const diff = state.content.find((c): c is Extract<ToolCallContent, { type: 'diff' }> => c.type === 'diff' && typeof c.path === 'string');
    return diff ? { path: path.resolve(this.ctx.root, diff.path), before: diff.oldText ?? null, after: diff.newText ?? null } : undefined;
  }

  viewOf(state: ToolState): ToolCallView {
    return this.cards.get(state.cardId) ?? this.buildView(state);
  }

  /** A card of Orka's own for something the agent did without announcing it (a write, a terminal). */
  showCard(view: ToolCallView): void {
    this.cards.set(view.id, view);
    this.ctx.emit({ type: 'tool_call', call: view });
  }

  /** Update a card shown with showCard. */
  patchCard(id: string, patch: Partial<ToolCallView>): void {
    const view = this.cards.get(id);
    if (!view) return;
    const next = { ...view, ...patch };
    this.cards.set(id, next);
    this.ctx.emit({ type: 'tool_call', call: next });
  }

  /** The running edit call that writes `absPath`, if the agent announced one. */
  callForPath(absPath: string): ToolState | undefined {
    const target = path.resolve(absPath);
    return [...this.tools.values()]
      .reverse()
      .find((s) => !s.ended && EDIT_KINDS.has(s.kind) && [...s.locations, ...diffPaths(s.content, this.ctx.root)].some((p) => samePath(p, target)));
  }

  /** The running execute call a new terminal belongs to: one with the same command, else the latest without a terminal. */
  callForCommand(commandLine: string): ToolState | undefined {
    const running = [...this.tools.values()].reverse().filter((s) => !s.ended && s.kind === 'execute');
    const linked = new Set(this.terminalCards.values());
    return running.find((s) => commandOf(s.rawInput) === commandLine) ?? running.find((s) => !linked.has(s.cardId));
  }

  linkTerminal(terminalId: string, cardId: string): void {
    this.terminalCards.set(terminalId, cardId);
  }

  terminalCard(terminalId: string): string | undefined {
    return this.terminalCards.get(terminalId);
  }

  /** A file the agent wrote through Orka (fs/write_text_file). */
  noteWrite(absPath: string): void {
    this.lastEdit = ++this.seq;
    if (!NON_CODE_EXTENSIONS.has(path.extname(absPath).toLowerCase())) this.changedCode = true;
  }

  /** A command the agent ran through Orka's terminal. */
  noteCommand(): void {
    this.lastCommand = ++this.seq;
  }

  /** The turn is over: close the answer and settle every card still running. */
  finish(stopReason: StopReason): void {
    this.closeBubble();
    for (const state of this.tools.values()) {
      if (state.ended || state.denied) continue;
      state.status = stopReason === 'cancelled' ? 'cancelled' : 'done';
      state.ended = true;
      this.emitTool(state);
    }
    for (const view of this.cards.values()) {
      if (view.status === 'running' || view.status === 'awaiting_approval') this.patchCard(view.id, { status: stopReason === 'cancelled' ? 'cancelled' : 'done' });
    }
  }

  private end(state: ToolState, ok: boolean): void {
    state.ended = true;
    state.awaiting = false;
    if (!state.denied) state.status = ok ? 'done' : 'error';
    const output = oneLine(this.outputOf(state) ?? '', 160);
    this.activity.push(`- ${state.kind}: ${oneLine(state.title || state.kind, 120)} -> ${ok ? 'ok' : `ERROR${output ? `: ${output}` : ''}`}`);
    if (this.activity.length > ACTIVITY_LINES) this.activity.splice(0, this.activity.length - ACTIVITY_LINES);
    if (!ok) return;
    if (EDIT_KINDS.has(state.kind)) {
      this.lastEdit = ++this.seq;
      const paths = [...state.locations, ...diffPaths(state.content, this.ctx.root)];
      if (!paths.length || paths.some((p) => !NON_CODE_EXTENSIONS.has(path.extname(p).toLowerCase()))) this.changedCode = true;
    } else if (state.kind === 'execute') this.lastCommand = ++this.seq;
  }

  private emitTool(state: ToolState): void {
    const view = this.buildView(state);
    this.cards.set(state.cardId, view);
    this.ctx.emit({ type: 'tool_call', call: view });
  }

  private buildView(state: ToolState): ToolCallView {
    const action = this.actionOf(state);
    const details: string[] = [];
    if (action.command) details.push(`$ ${action.command}`);
    else if (state.kind === 'execute' && state.rawInput !== undefined) details.push(t('Input: {input}', { input: oneLine(JSON.stringify(state.rawInput) ?? '', 500) }));
    const url = state.kind === 'fetch' ? urlOf(state.rawInput) : undefined;
    if (url) details.push(url);
    // Every file the call names, so an approval shows all of them (the card's path is only the first).
    const inside = state.locations.filter((p) => isInside(this.ctx.root, p));
    if (inside.length > 1) details.push(t('Files: {paths}', { paths: inside.map((p) => toRelative(this.ctx.root, p)).join(', ') }));
    if (action.outside.length) details.push(t('Outside the workspace: {paths}', { paths: action.outside.join(', ') }));
    if (action.reason) details.push(t('Risk: {reason}', { reason: t(action.reason) }));
    const output = state.denied ?? this.outputOf(state);
    return {
      id: state.cardId,
      name: `acp:${state.kind}`,
      title: state.title || state.kind,
      category: action.category,
      risk: action.risk,
      status: state.status,
      detail: details.length ? details.join('\n') : undefined,
      path: state.locations[0] ?? diffPaths(state.content, this.ctx.root)[0],
      ...(output ? { output } : {}),
      ...(state.status === 'awaiting_approval' ? { hasPreview: !!this.previewOf(state) } : {}),
    };
  }

  private outputOf(state: ToolState): string | undefined {
    const parts: string[] = [];
    for (const c of state.content) {
      if (c.type === 'content') {
        const text = blockText(c.content);
        if (text) parts.push(text);
      } else if (c.type === 'diff' && typeof c.path === 'string') {
        parts.push(unifiedDiff(toRelative(this.ctx.root, path.resolve(this.ctx.root, c.path)), c.oldText ?? null, c.newText ?? null));
      }
    }
    if (!parts.length && state.ended && state.rawOutput !== undefined) parts.push(typeof state.rawOutput === 'string' ? state.rawOutput : JSON.stringify(state.rawOutput, null, 2));
    const text = parts.filter(Boolean).join('\n');
    if (!text) return undefined;
    return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…` : text;
  }

  private openBubble(): { id: string; text: string } {
    if (this.bubble) return this.bubble;
    this.bubble = { id: this.ctx.nextId('a'), text: '' };
    if (this.text) this.text += '\n\n';
    this.ctx.emit({ type: 'assistant_start', id: this.bubble.id });
    return this.bubble;
  }

  private closeBubble(): void {
    const bubble = this.bubble;
    if (!bubble) return;
    this.bubble = undefined;
    if (bubble.text.trim()) this.lastText = bubble.text;
    this.ctx.emit({ type: 'assistant_end', id: bubble.id, text: bubble.text, model: this.ctx.label });
  }
}

/** Text of a content block (images and other media are not shown in the transcript). */
export function blockText(block: ContentBlock | undefined): string {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : '';
  if (block.type === 'resource_link') return `[${block.title ?? block.name}](${block.uri})`;
  if (block.type === 'resource') return block.resource?.text ?? '';
  return '';
}

function diffPaths(content: readonly ToolCallContent[], root: string): string[] {
  return content.filter((c) => c.type === 'diff' && typeof c.path === 'string').map((c) => path.resolve(root, (c as { path: string }).path));
}

function urlOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const input = rawInput as Record<string, unknown>;
  const value = input.url ?? input.uri ?? input.query;
  return typeof value === 'string' ? value : undefined;
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(root, target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

/** A card id part made of letters, digits, dash and underscore only (ids end up in the DOM). */
export function safeId(value: string): string {
  return value.replace(/[^\w-]/g, '_').slice(-60) || '_';
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
