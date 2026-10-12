import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { t } from '../i18n';
import { addUsage, type AssistantMessage, type ChatMessage, type ImageBlock, type Usage } from '../types';
import {
  AbortedError,
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  ProviderError,
  type ProviderStreamEvent,
  type StopReason,
} from './AIProvider';
import {
  findUnparsedCallAttempt,
  parseToolCalls,
  renderToolInstructions,
  renderTranscript,
  renderUserTurn,
  repairRequest,
  ToolCallStreamFilter,
  toolNameIndex,
  userImages,
} from './textToolProtocol';

export interface ClaudeCodeProviderOptions {
  /** Alias ("opus", "sonnet", "haiku", "fable") or full model id. Empty / "default" = the CLI's default. */
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Path to the `claude` executable. Auto-detected when empty. */
  executable?: string;
  /** Arguments placed before the CLI flags (lets tests run a fake CLI through node). */
  executableArgs?: string[];
  /** Kill a conversation's CLI process after this long without use. */
  idleTimeoutMs?: number;
}

const PROVIDER_ID = 'claude-code';
/** Idle sessions kept alive; busy ones (parallel sub-agents) are never evicted. */
const MAX_SESSIONS = 8;

/**
 * Uses the locally installed Claude Code CLI (and whatever account it is logged in with) as a
 * plain model: its built-in tools, MCP servers, settings and slash commands are all disabled,
 * and our tools are offered through the text tool protocol, so the orchestrator keeps full
 * control of execution, permissions and diffs.
 *
 * Each conversation keeps one long-lived `claude -p --input-format stream-json` process and
 * only sends the new turn, so Claude Code's prompt caching works across the agent loop.
 */
export class ClaudeCodeProvider implements AIProvider {
  readonly id = PROVIDER_ID;
  readonly label = 'Claude Code';
  readonly model: string;
  /** Keyed by the first message object of a conversation (main agent and sub-agents differ). */
  private readonly sessions = new Map<object, CliSession>();
  private callCounter = 0;

  constructor(private readonly options: ClaudeCodeProviderOptions = {}) {
    this.model = options.model?.trim() && options.model.trim() !== 'default' ? options.model.trim() : 'default';
  }

  async chat(request: ChatRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<ChatResponse> {
    if (request.signal?.aborted) throw new AbortedError();
    const key = request.messages[0] as object;
    const system = request.tools.length ? `${request.system}\n\n${renderToolInstructions(request.tools)}` : request.system;
    let session = this.sessions.get(key);
    let payload: string;
    let images: ImageBlock[];
    if (session?.alive && session.system === system && isPrefix(session.seen, request.messages)) {
      const names = toolNameIndex(request.messages);
      const fresh = request.messages.slice(session.seen.length);
      payload = fresh
        .map((m) => (m.role === 'user' ? renderUserTurn(m, names) : ''))
        .filter(Boolean)
        .join('\n\n');
      images = userImages(fresh);
    } else {
      session?.kill();
      session = new CliSession(this.spawnArgs(), system);
      payload = renderTranscript(request.messages);
      // A restarted session gets the images of the latest message only; earlier ones are noted in the transcript.
      images = userImages(request.messages.slice(-1));
    }
    this.sessions.delete(key);
    this.sessions.set(key, session); // most recently used last
    this.evict(key);

    const onAbort = () => session!.kill();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    let reasoning = '';
    let streamedText = false;
    const filter = new ToolCallStreamFilter(
      (text) => {
        streamedText = true;
        onEvent({ type: 'text_delta', text });
      },
      (name) => onEvent({ type: 'tool_call_start', id: '', name }),
    );

    try {
      const input: CliContent = images.length
        ? [{ type: 'text', text: payload }, ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } }))]
        : payload;
      const turn = await session.turn(input, (event) => {
        if (event.type === 'text') filter.push(event.text);
        else if (event.type === 'thinking') {
          reasoning += event.text;
          onEvent({ type: 'reasoning_delta', text: event.text });
        }
      });
      filter.flush();
      const makeId = () => `cc_${Date.now().toString(36)}_${this.callCounter++}`;
      let parsed = parseToolCalls(turn.text, request.tools, makeId);
      let usage = turn.usage;
      let stopReason = turn.stopReason;
      const attempt = request.tools.length ? findUnparsedCallAttempt(turn.text, parsed) : -1;
      if (attempt >= 0 && stopReason !== 'max_tokens') {
        // A broken call would otherwise end the agent's turn as if it were its final answer.
        onEvent({ type: 'notice', message: t('Claude Code wrote a tool call that could not be read; asking it to write the call again.') });
        const retry = await session.turn(repairRequest(), () => {});
        usage = addUsage(usage, retry.usage);
        stopReason = retry.stopReason;
        const reparsed = parseToolCalls(retry.text, request.tools, makeId);
        const prose = parseToolCalls(turn.text.slice(0, attempt), [], makeId).text;
        parsed = reparsed.calls.length ? { text: prose, calls: reparsed.calls } : reparsed;
      }
      if (!streamedText && parsed.text) onEvent({ type: 'text_delta', text: parsed.text });
      const content: AssistantMessage['content'] = [];
      const finalReasoning = turn.reasoning || reasoning;
      if (finalReasoning.trim()) content.push({ type: 'reasoning', text: finalReasoning });
      if (parsed.text) content.push({ type: 'text', text: parsed.text });
      content.push(...parsed.calls);
      const message: AssistantMessage = { role: 'assistant', content };
      session.seen = [...request.messages, message];
      return {
        message,
        stopReason: parsed.calls.length ? 'tool_use' : stopReason,
        usage,
        model: turn.model || this.model,
      };
    } catch (error) {
      session.kill();
      this.sessions.delete(key);
      if (request.signal?.aborted) throw new AbortedError();
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
  }

  private spawnArgs(): SpawnSpec {
    const executable = resolveClaudeExecutable(this.options.executable);
    if (!executable) {
      throw new ProviderError(
        'Claude Code CLI was not found. Install it (npm install -g @anthropic-ai/claude-code) and log in with "claude", or set its path in the settings.',
        'other',
      );
    }
    const flags = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--setting-sources',
      '',
    ];
    if (this.model !== 'default') flags.push('--model', this.model);
    if (this.options.effort) flags.push('--effort', this.options.effort);
    return { executable, prefixArgs: this.options.executableArgs ?? [], flags, idleTimeoutMs: this.options.idleTimeoutMs ?? 15 * 60_000 };
  }

  private evict(keep: object): void {
    for (const [key, session] of this.sessions) {
      if (this.sessions.size <= MAX_SESSIONS) break;
      if (session.busy || key === keep) continue;
      session.kill();
      this.sessions.delete(key);
    }
  }
}

interface SpawnSpec {
  executable: string;
  prefixArgs: string[];
  flags: string[];
  idleTimeoutMs: number;
}

type CliStreamEvent = { type: 'text'; text: string } | { type: 'thinking'; text: string };

/** A user message for stream-json input: plain text, or text plus image blocks. */
type CliContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>;

interface TurnResult {
  text: string;
  reasoning: string;
  usage: Usage;
  model: string;
  stopReason: StopReason;
}

/** One `claude -p` process in streaming-input mode: write a user message, read until `result`. */
class CliSession {
  seen: ChatMessage[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly dir: string;
  private lineBuffer = '';
  private stderrTail = '';
  private exited = false;
  private idleTimer?: NodeJS.Timeout;
  private model = '';
  private pending?: {
    onEvent: (event: CliStreamEvent) => void;
    resolve: (result: TurnResult) => void;
    reject: (error: Error) => void;
    text: string;
    reasoning: string;
  };

  constructor(
    private readonly spec: SpawnSpec,
    readonly system: string,
  ) {
    // A neutral working directory keeps project CLAUDE.md files out of the model's context;
    // the orchestrator supplies project context itself.
    this.dir = path.join(tmpdir(), 'orka-claude-code', randomUUID());
    mkdirSync(this.dir, { recursive: true });
    const systemFile = path.join(this.dir, 'system-prompt.md');
    writeFileSync(systemFile, system, 'utf8');
    const env = { ...process.env };
    // Use the CLI's own login (subscription or configured auth), not a key meant for the API provider.
    delete env.ANTHROPIC_API_KEY;
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = spawn(spec.executable, [...spec.prefixArgs, ...spec.flags, '--system-prompt-file', systemFile], {
      cwd: this.dir,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (data: Buffer) => this.onStdout(data.toString('utf8')));
    this.child.stderr.on('data', (data: Buffer) => {
      this.stderrTail = (this.stderrTail + data.toString('utf8')).slice(-2000);
    });
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      const message =
        error.code === 'ENOENT'
          ? `Claude Code CLI not found at "${spec.executable}".`
          : `Could not start Claude Code: ${error.message}`;
      this.fail(new ProviderError(message, 'other'));
    });
    this.child.on('exit', (code) => {
      this.exited = true;
      const detail = this.stderrTail.trim() ? `: ${this.stderrTail.trim().split(/\r?\n/).slice(-3).join(' ')}` : '';
      this.fail(new ProviderError(`Claude Code exited unexpectedly (code ${code})${detail}`, 'other'));
      this.cleanup();
    });
    this.child.stdin.on('error', () => {
      /* reported through 'exit' */
    });
    this.touch();
  }

  get alive(): boolean {
    return !this.exited;
  }

  get busy(): boolean {
    return !!this.pending;
  }

  turn(content: CliContent, onEvent: (event: CliStreamEvent) => void): Promise<TurnResult> {
    if (this.exited) return Promise.reject(new ProviderError('Claude Code session has ended.', 'other'));
    if (this.pending) return Promise.reject(new Error('Claude Code session is busy.'));
    this.touch();
    return new Promise((resolve, reject) => {
      this.pending = { onEvent, resolve, reject, text: '', reasoning: '' };
      this.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
    });
  }

  kill(): void {
    if (this.exited) return;
    this.exited = true;
    killTree(this.child.pid);
    this.fail(new AbortedError());
    this.cleanup();
  }

  private onStdout(chunk: string): void {
    this.lineBuffer += chunk;
    let newline: number;
    while ((newline = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // not a protocol line
      }
      this.handle(message);
    }
  }

  private handle(message: any): void {
    const pending = this.pending;
    if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string') this.model = message.model;
    if (!pending) return;
    switch (message.type) {
      case 'stream_event': {
        const event = message.event;
        if (message.parent_tool_use_id) break;
        if (event?.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) pending.onEvent({ type: 'text', text: event.delta.text });
          else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
            pending.onEvent({ type: 'thinking', text: event.delta.thinking });
          }
        }
        break;
      }
      case 'assistant': {
        if (message.parent_tool_use_id) break;
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text' && typeof block.text === 'string') pending.text += block.text;
          else if (block.type === 'thinking' && typeof block.thinking === 'string') pending.reasoning += block.thinking;
        }
        break;
      }
      case 'result': {
        this.pending = undefined;
        this.touch();
        if (message.is_error) {
          const text = String(message.result ?? message.errors?.join?.(' ') ?? 'Claude Code reported an error.');
          // A model id newer than the installed CLI: offer the update, and the alias as a way around it.
          if (/or newer is required|claude update/i.test(text)) {
            const hint = t('Or pick an alias such as "Opus (latest)" for this agent; aliases always match the installed CLI.');
            pending.reject(new ProviderError(`Claude Code: ${text} ${hint}`, 'bad_request', undefined, 'claudeUpdate'));
            return;
          }
          pending.reject(new ProviderError(`Claude Code: ${text}`, classifyError(text)));
          return;
        }
        const u = message.usage ?? {};
        pending.resolve({
          text: pending.text || (typeof message.result === 'string' ? message.result : ''),
          reasoning: pending.reasoning,
          usage: {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          },
          model: this.model,
          stopReason: message.stop_reason === 'max_tokens' ? 'max_tokens' : message.stop_reason === 'refusal' ? 'refusal' : 'end_turn',
        });
        break;
      }
    }
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill(), this.spec.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private cleanup(): void {
    clearTimeout(this.idleTimer);
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function classifyError(text: string): ProviderError['kind'] {
  if (/limit|quota|rate|overloaded/i.test(text)) return 'rate_limit';
  if (/log ?in|auth|credential|api key|unauthori|forbidden/i.test(text)) return 'auth';
  return 'other';
}

function isPrefix(prefix: readonly ChatMessage[], messages: readonly ChatMessage[]): boolean {
  if (!prefix.length || prefix.length > messages.length) return false;
  return prefix.every((m, i) => m === messages[i]);
}

/** Find the Claude Code executable: explicit path, npm global install, native installer, PATH. */
export function resolveClaudeExecutable(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const home = homedir();
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    }
    candidates.push(path.join(home, '.local', 'bin', 'claude.exe'));
    const where = spawnSync('where', ['claude.exe'], { encoding: 'utf8', windowsHide: true });
    if (where.status === 0) candidates.push(...where.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } else {
    candidates.push(path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude');
    const which = spawnSync('which', ['claude'], { encoding: 'utf8' });
    if (which.status === 0) candidates.push(which.stdout.trim());
  }
  return candidates.find((c) => c && existsSync(c)) ?? '';
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}
