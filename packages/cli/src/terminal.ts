import type { Interface as ReadLine } from 'node:readline';
import {
  estimateCost,
  t,
  unifiedDiff,
  type AgentEvent,
  type ApprovalRequest,
  type ApprovalResponse,
  type FileChange,
  type Plan,
  type RunEndReason,
  type ToolCallView,
  type Usage,
} from '@orka/core';

export interface Style {
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
}

export function style(color: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    dim: wrap(2, 22),
    bold: wrap(1, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
  };
}

type Write = (text: string) => void;

/**
 * Prints agent events as a readable transcript. The reply streams to `out`; progress (tools,
 * notices, supervisor) goes to `info`, which in --print mode is stderr so stdout stays the answer.
 */
export class Renderer {
  private midLine = false;
  private seen = new Map<string, ToolCallView['status']>();
  private lastPlan = '';
  /** `unreported`: an agent CLI did part of the work and does not report its tokens. */
  usage?: { total: Usage; model: string; provider?: string; unreported?: boolean };
  changes: FileChange[] = [];

  constructor(
    private readonly out: Write,
    private readonly info: Write,
    private readonly s: Style,
  ) {}

  /** Start progress output on a fresh line, after streamed reply text. */
  private line(text: string): void {
    if (this.midLine) {
      this.out('\n');
      this.midLine = false;
    }
    this.info(`${text}\n`);
  }

  handle(event: AgentEvent): void {
    const s = this.s;
    switch (event.type) {
      case 'run_started':
        this.seen.clear();
        break;
      case 'assistant_delta':
        if (!event.text) break;
        this.out(event.text);
        this.midLine = !event.text.endsWith('\n');
        break;
      case 'assistant_end':
        if (this.midLine) {
          this.out('\n');
          this.midLine = false;
        }
        break;
      case 'tool_call':
        this.tool(event.call);
        break;
      case 'tool_output':
        if (this.seen.get(event.id) === 'running') this.info(s.dim(indent(event.chunk.replace(/\r/g, ''))));
        break;
      case 'subagent':
        if (event.event.type === 'tool_call' && event.event.call.status === 'running') this.line(s.dim(`   ↳ ${event.agent}: ${event.event.call.title}`));
        break;
      case 'plan':
        this.plan(event.plan);
        break;
      case 'changes':
        this.changes = event.changes;
        break;
      case 'usage':
        this.usage = {
          total: event.total,
          model: event.model,
          provider: event.byAgent?.find((a) => a.agent === 'main')?.provider,
          unreported: !!event.byAgent?.some((a) => a.unreported),
        };
        break;
      case 'notice': {
        const mark = event.level === 'error' ? s.red('✗') : event.level === 'warning' ? s.yellow('!') : s.cyan('i');
        this.line(`${mark} ${event.message}`);
        break;
      }
      case 'supervisor':
        if (event.status === 'reviewing') {
          this.line(s.dim(`◆ ${t('Supervisor')}: ${t('checking…')}`));
        } else if (event.status === 'intervened' && event.message) {
          this.line(`${s.magenta('◆')} ${s.bold(t('Supervisor'))}: ${event.message}`);
        } else if (event.status === 'ok' && event.message && event.scope !== 'step') {
          this.line(s.dim(`◆ ${t('Supervisor')}: ${event.message}`));
        } else if (event.status === 'error' && event.message) {
          this.line(s.yellow(`◆ ${t('Supervisor')}: ${event.message}`));
        }
        break;
      case 'compaction':
        if (event.status === 'running') this.line(s.dim(t('Compacting the conversation…')));
        else if (event.status === 'done') this.line(s.dim(t('Conversation compacted: {before} → {after} tokens', { before: event.beforeTokens ?? '?', after: event.afterTokens ?? '?' })));
        else if (event.message) this.line(s.yellow(event.message));
        break;
      default:
        break;
    }
  }

  private tool(call: ToolCallView): void {
    const s = this.s;
    const before = this.seen.get(call.id);
    this.seen.set(call.id, call.status);
    if (before === call.status || call.status === 'awaiting_approval') return;
    if (call.name === 'update_plan') return; // shown by the plan event
    switch (call.status) {
      case 'running':
        this.line(`${s.cyan('●')} ${call.title}`);
        break;
      case 'done':
        if (!before) this.line(`${s.cyan('●')} ${call.title}`);
        break;
      case 'error': {
        if (!before) this.line(`${s.cyan('●')} ${call.title}`);
        const first = (call.output ?? '').trim().split('\n').slice(0, 3).join('\n');
        this.line(s.red(indent(`✗ ${first || t('failed')}`)));
        break;
      }
      case 'denied':
        this.line(s.yellow(indent(`⊘ ${t('Not allowed')}: ${call.title}`)));
        break;
      case 'cancelled':
        this.line(s.dim(indent(`■ ${t('Cancelled')}: ${call.title}`)));
        break;
    }
  }

  private plan(plan: Plan | undefined): void {
    if (!plan?.steps.length) return;
    const text = plan.steps.map((step) => `${step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▸' : '·'} ${step.title}`).join('\n');
    if (text === this.lastPlan) return;
    this.lastPlan = text;
    const s = this.s;
    this.line(s.bold(t('Plan')));
    for (const [i, step] of plan.steps.entries()) {
      const row = text.split('\n')[i];
      this.line(step.status === 'completed' ? s.dim(`  ${row}`) : step.status === 'in_progress' ? s.cyan(`  ${row}`) : `  ${row}`);
    }
  }

  /** One line after a request: why it stopped (if not done), changed files, tokens and cost. */
  summary(reason: RunEndReason, error?: string): void {
    const s = this.s;
    if (reason === 'error') this.line(s.red(`✗ ${error ?? t('The request failed.')}`));
    else if (reason === 'stopped') this.line(s.yellow(t('Stopped.')));
    else if (reason === 'max_iterations') this.line(s.yellow(t('Paused after the step limit. Say "continue" to go on.')));
    else if (reason === 'budget') this.line(s.yellow(t('Paused: the token budget for this request is used up. Say "continue" to go on.')));
    else if (reason === 'refusal') this.line(s.yellow(t('The model declined this request.')));
    const parts: string[] = [];
    if (this.changes.length) {
      const added = this.changes.reduce((n, c) => n + c.added, 0);
      const removed = this.changes.reduce((n, c) => n + c.removed, 0);
      parts.push(`${this.changes.length} ${t('file(s) changed')} ${s.green(`+${added}`)} ${s.red(`-${removed}`)}`);
    }
    if (this.usage) {
      const u = this.usage.total;
      const input = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
      // An agent CLI's tokens are unknown: say so instead of showing them as 0.
      if (input + u.outputTokens > 0 || !this.usage.unreported) parts.push(`${formatTokens(input)} in · ${formatTokens(u.outputTokens)} out`);
      if (this.usage.unreported) parts.push(t('token use not reported'));
      const cost = estimateCost(this.usage.provider ?? '', this.usage.model, u);
      if (cost.kind === 'usd') parts.push(`~$${cost.usd.toFixed(cost.usd < 1 ? 3 : 2)}`);
      else if (cost.kind === 'subscription') parts.push(t('subscription'));
      parts.push(this.usage.model);
    }
    if (parts.length) this.line(s.dim(parts.join('  ·  ')));
  }
}

function indent(text: string): string {
  return text.replace(/^(?=.)/gm, '    ');
}

export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Asks the user to approve an action in the terminal. Without a terminal to ask (piped input),
 * actions that need approval are declined with a hint, never approved silently.
 */
export class Approver {
  private pending?: AbortController;

  constructor(
    private readonly rl: ReadLine | undefined,
    private readonly info: Write,
    private readonly s: Style,
  ) {}

  async approve(request: ApprovalRequest): Promise<ApprovalResponse> {
    const s = this.s;
    if (!this.rl) {
      this.info(s.yellow(`⊘ ${t('Needs approval, declined (no terminal to ask): {title}', { title: request.title })}\n`));
      return { approved: false, feedback: 'The user is not available to approve this. Continue without it, or explain what they should run or allow (e.g. --mode autonomous).' };
    }
    const risk = request.risk === 'dangerous' ? s.red(` [${t('dangerous')}]`) : '';
    this.info(`\n${s.yellow('?')} ${s.bold(request.title)}${risk}\n`);
    if (request.detail) this.info(s.dim(indent(request.detail.trim().split('\n').slice(0, 12).join('\n'))) + '\n');
    const abort = new AbortController();
    this.pending = abort;
    try {
      return await this.ask(this.rl, request, abort.signal);
    } finally {
      this.pending = undefined;
    }
  }

  /** Whether a question is open (Ctrl+C then declines it). */
  get asking(): boolean {
    return !!this.pending;
  }

  /** Decline the open question (Ctrl+C). */
  cancel(): void {
    this.pending?.abort();
  }

  private async ask(rl: ReadLine, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResponse> {
    const s = this.s;
    const hasDiff = !!request.preview;
    for (;;) {
      const options = `${s.bold('y')} ${t('yes')} · ${s.bold('a')} ${t('always')} · ${s.bold('n')} ${t('no')}${hasDiff ? ` · ${s.bold('d')} diff` : ''} · ${t('or type what to do instead')}`;
      const answer = (await question(rl, `  ${options}\n  › `, signal)).trim();
      if (signal.aborted) return { approved: false };
      const key = answer.toLowerCase();
      if (key === 'y' || key === 'yes' || key === 'e' || key === 'evet') return { approved: true };
      if (key === 'a' || key === 'always' || key === 'her zaman') return { approved: true, alwaysAllow: true };
      if (key === 'n' || key === 'no' || key === 'h' || key === 'hayır' || key === '') return { approved: false };
      if (key === 'd' && request.preview) {
        this.info(colorDiff(unifiedDiff(request.preview.path, request.preview.before, request.preview.after), s) + '\n');
        continue;
      }
      return { approved: false, feedback: answer };
    }
  }
}

export function colorDiff(diff: string, s: Style): string {
  return diff
    .split('\n')
    .map((l) => (l.startsWith('+++') || l.startsWith('---') ? s.bold(l) : l.startsWith('+') ? s.green(l) : l.startsWith('-') ? s.red(l) : l.startsWith('@@') ? s.cyan(l) : l))
    .join('\n');
}

export function question(rl: ReadLine, prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    if (!signal) return rl.question(prompt, resolve);
    signal.addEventListener('abort', () => resolve(''), { once: true });
    rl.question(prompt, { signal }, resolve);
  });
}
