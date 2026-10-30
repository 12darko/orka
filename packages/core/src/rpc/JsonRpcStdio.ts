import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { childEnv, resolveCommand } from '../host/commands';
import { killTree } from '../host/processes';

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdin/stdout, in both directions: Orka
 * sends requests and notifications, and the program can send requests back (an ACP agent asks to
 * read a file or for permission), which go to a handler. Used by the ACP client; the MCP client
 * keeps its own copy for now.
 */
export interface StdioCommand {
  command: string;
  args: string[];
  cwd: string;
  /** The child's whole environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
}

export interface JsonRpcStdioOptions {
  /** Names the program in errors ("Gemini CLI exited (code 1): ..."). */
  name: string;
  /** Answers a request from the program; throw a JsonRpcError to answer with an error. */
  onRequest?: (method: string, params: any) => unknown;
  onNotification?: (method: string, params: any) => void;
  /** Called once when the process is gone (exited, failed to start, or closed). */
  onClose?: (reason: string) => void;
}

export interface RequestOptions {
  /** 0 or undefined: wait as long as it takes (an agent's turn can run for many minutes). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export const RPC_INVALID_PARAMS = -32602;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;

/** Stderr kept for error messages. */
const STDERR_TAIL = 4_000;
/** A line longer than this without a newline is not a protocol the client speaks. */
const MAX_LINE = 64 * 1024 * 1024;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonRpcStdio {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private stderrTail = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedReason?: string;

  constructor(
    private readonly command: StdioCommand,
    private readonly options: JsonRpcStdioOptions,
  ) {}

  /** Start the process. Failing to start is reported through onClose and rejects every request. */
  start(): void {
    if (this.child || this.closedReason) return;
    const { file, args, shell } = resolveCommand(this.command.command, this.command.args);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(file, args, {
        cwd: this.command.cwd,
        // The cwd is the workspace: on Windows, programs started by bare name must not come from it.
        env: childEnv(this.command.env ?? process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell,
        // Own process group on POSIX, so close() can stop whatever the agent started too.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      // e.g. EINVAL for a batch file started without a shell
      this.finish(`${this.options.name} could not start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.child = child;
    // Decode as one stream, so a character split across two chunks stays whole.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.on('data', (chunk: string) => (this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL)));
    child.on('error', (error: NodeJS.ErrnoException) =>
      this.finish(error.code === 'ENOENT' ? `${this.options.name} was not found (${this.command.command})` : `${this.options.name} could not start: ${error.message}`),
    );
    // 'close' comes after stdout is drained, so the last answers are read before pending calls fail.
    child.on('close', (code, signal) => {
      const tail = lastLines(this.stderrTail);
      this.finish(`${this.options.name} exited (${code === null ? `signal ${signal}` : `code ${code}`})${tail ? `: ${tail}` : ''}`);
    });
    child.stdin.on('error', () => {
      /* reported through close */
    });
  }

  get running(): boolean {
    return !!this.child && !this.closedReason;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The end of what the program wrote to stderr (it often explains a failure). */
  get stderr(): string {
    return this.stderrTail;
  }

  request<T = any>(method: string, params: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closedReason) return Promise.reject(new Error(this.closedReason));
    if (!this.child) return Promise.reject(new Error(`${this.options.name} is not running`));
    if (options.signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => settle(() => reject(abortError()));
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        fn();
      };
      if (options.timeoutMs) {
        timer = setTimeout(() => settle(() => reject(new Error(`${this.options.name}: no answer to ${method} within ${Math.round(options.timeoutMs! / 1000)}s`))), options.timeoutMs);
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => settle(() => resolve(value as T)),
        reject: (error) => settle(() => reject(error)),
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedReason) return;
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** Stop the process (and what it started) and fail every pending call. */
  close(reason = `${this.options.name} was closed`): void {
    const pid = this.child?.pid;
    const running = this.running;
    this.finish(reason);
    if (running) killTree(pid);
  }

  private write(message: unknown): void {
    try {
      // JSON.stringify escapes newlines inside strings, so one message is always one line.
      this.child?.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* reported through close */
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      // trim() also drops the \r of programs that write CRLF line endings.
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
    if (this.buffer.length > MAX_LINE) this.close(`${this.options.name} sent a line longer than ${MAX_LINE / 1024 / 1024} MB`);
  }

  private onLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return; // programs sometimes log to stdout
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === 'string') {
      if (hasId) void this.answer(message.id, message.method, message.params);
      else {
        try {
          this.options.onNotification?.(message.method, message.params);
        } catch {
          /* a broken listener must not stop the connection */
        }
      }
      return;
    }
    if (!hasId) return;
    const pending = this.pending.get(typeof message.id === 'number' ? message.id : Number(message.id));
    if (!pending) return;
    if (message.error) {
      const error = message.error;
      pending.reject(new JsonRpcError(String(error.message ?? `${pending.method} failed`), Number(error.code ?? RPC_INTERNAL_ERROR), error.data));
    } else pending.resolve(message.result);
  }

  /** Answer a request from the program with the handler's result or error. */
  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    if (!this.options.onRequest) {
      this.write({ jsonrpc: '2.0', id, error: { code: RPC_METHOD_NOT_FOUND, message: `Method not supported by this client: ${method}` } });
      return;
    }
    try {
      const result = await this.options.onRequest(method, params);
      this.write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      const code = error instanceof JsonRpcError ? error.code : RPC_INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : String(error);
      this.write({ jsonrpc: '2.0', id, error: { code, message } });
    }
  }

  private finish(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    const error = new Error(reason);
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.pending.clear();
    this.child?.stdout.removeAllListeners('data');
    try {
      this.options.onClose?.(reason);
    } catch {
      /* listeners are best-effort */
    }
  }
}

function abortError(): Error {
  return Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

function lastLines(text: string): string {
  return text.trim().split(/\r?\n/).slice(-3).join(' ');
}
