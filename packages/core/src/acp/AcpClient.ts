import { JsonRpcError, JsonRpcStdio, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND } from '../rpc/JsonRpcStdio';
import { VERSION } from '../version';
import {
  ACP_PROTOCOL_VERSION,
  ACP_RESOURCE_NOT_FOUND,
  type ContentBlock,
  type CreateTerminalParams,
  type InitializeParams,
  type InitializeResult,
  type PermissionOutcome,
  type ReadTextFileParams,
  type RequestPermissionParams,
  type SessionUpdate,
  type StopReason,
  type TerminalExitStatus,
  type TerminalOutputResult,
  type TerminalParams,
  type WriteTextFileParams,
} from './types';

/** How to start one agent: always a program the user installed, never a download. */
export interface AcpLaunchSpec {
  /** Catalog id ("gemini", "custom:my-agent"). */
  agentId: string;
  /** Shown in notices and errors ("Gemini CLI"). */
  label: string;
  /** The executable: an absolute path found on PATH or set by the user. */
  command: string;
  args: string[];
  /** The folder the process starts in (the workspace). */
  cwd: string;
  /** Extra environment variables. Names that look like credentials are dropped (see safeEnv). */
  env?: Record<string, string>;
  /** The vendor's own login command, for the "not logged in" notice. */
  loginCommand?: string;
}

/** What one ACP session answers for its agent. */
export interface AcpSessionHandlers {
  update(update: SessionUpdate): void;
  requestPermission(params: RequestPermissionParams): Promise<PermissionOutcome>;
  readTextFile(params: ReadTextFileParams): Promise<{ content: string }>;
  writeTextFile(params: WriteTextFileParams): Promise<void>;
  createTerminal(params: CreateTerminalParams): Promise<{ terminalId: string }>;
  terminalOutput(params: TerminalParams): TerminalOutputResult;
  waitForTerminalExit(params: TerminalParams): Promise<TerminalExitStatus>;
  killTerminal(params: TerminalParams): void;
  releaseTerminal(params: TerminalParams): void;
}

export interface AcpClientOptions {
  /** For initialize and session/new (agents can be slow to start). Default 60 s. */
  startTimeoutMs?: number;
}

const START_TIMEOUT_MS = 60_000;
/** A browser sign-in the user completes by hand can take a while. */
const AUTHENTICATE_TIMEOUT_MS = 5 * 60_000;

/**
 * One agent process speaking ACP over stdio. Orka is the client: it starts the agent, opens
 * sessions and sends prompts; the agent streams updates and asks Orka to read and write files,
 * run terminal commands and approve its tool calls. Requests are routed to the session they name,
 * so one process can serve several sessions.
 */
export class AcpClient {
  private readonly rpc: JsonRpcStdio;
  private readonly sessions = new Map<string, AcpSessionHandlers>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private starting?: Promise<InitializeResult>;
  private closedReason?: string;
  /** The agent's answer to initialize, once started. */
  init?: InitializeResult;

  constructor(
    readonly spec: AcpLaunchSpec,
    private readonly options: AcpClientOptions = {},
  ) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...safeEnv(spec.env) };
    // Set when Orka runs inside VS Code's extension host; it would make an Electron-based CLI act as plain Node.
    delete env.ELECTRON_RUN_AS_NODE;
    this.rpc = new JsonRpcStdio(
      { command: spec.command, args: spec.args, cwd: spec.cwd, env },
      {
        name: spec.label,
        onRequest: (method, params) => this.onRequest(method, params),
        onNotification: (method, params) => this.onNotification(method, params),
        onClose: (reason) => {
          this.closedReason = reason;
          for (const listener of this.closeListeners) listener(reason);
        },
      },
    );
  }

  get alive(): boolean {
    return !this.closedReason;
  }

  /** Why the process is gone, once it is. */
  get closeReason(): string | undefined {
    return this.closedReason;
  }

  /** The end of the agent's stderr (it often explains a failure). */
  get stderr(): string {
    return this.rpc.stderr;
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Start the process and do the handshake (once). Aborting `signal` stops waiting for it at once;
   * the handshake itself goes on for other callers (the pool stops a process nobody waits for).
   */
  start(signal?: AbortSignal): Promise<InitializeResult> {
    if (this.init) return Promise.resolve(this.init);
    this.starting ??= this.doStart().catch((error: unknown) => {
      this.close();
      throw error;
    });
    return signal ? untilAborted(this.starting, signal) : this.starting;
  }

  private async doStart(): Promise<InitializeResult> {
    this.rpc.start();
    const params: InitializeParams = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // Orka serves files and terminals itself, so the agent's writes and commands go through Orka's permissions and change list.
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'orka', title: 'Orka', version: VERSION },
    };
    const init = await this.rpc.request<InitializeResult>('initialize', params, { timeoutMs: this.options.startTimeoutMs ?? START_TIMEOUT_MS });
    if (!init || init.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(`${this.spec.label} speaks ACP version ${init?.protocolVersion ?? '?'}; Orka supports version ${ACP_PROTOCOL_VERSION}.`);
    }
    this.init = init;
    return init;
  }

  /** Open a session in `cwd`; its requests go to `handlers` until forgetSession. Aborting `signal` stops waiting at once. */
  async newSession(cwd: string, handlers: AcpSessionHandlers, signal?: AbortSignal): Promise<string> {
    await this.start(signal);
    // No MCP servers are passed on: the agent uses the ones its own configuration names.
    const result = await this.rpc.request<{ sessionId?: unknown }>('session/new', { cwd, mcpServers: [] }, { timeoutMs: this.options.startTimeoutMs ?? START_TIMEOUT_MS, signal });
    const sessionId = result?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error(`${this.spec.label} did not return a session id.`);
    this.sessions.set(sessionId, handlers);
    return sessionId;
  }

  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Ask the agent to sign in with one of the methods it advertised. Only ever on the user's
   * request, only with a method the vendor's policy lists, and never a "terminal" method (those
   * run the vendor's own login in a terminal instead). Credentials stay inside the agent.
   */
  async authenticate(methodId: string, allowed: readonly string[]): Promise<void> {
    const init = await this.start();
    const method = init.authMethods?.find((m) => m.id === methodId);
    if (!method) throw new Error(`${this.spec.label} does not offer the sign-in method "${methodId}".`);
    if (method.type === 'terminal' || !allowed.includes(methodId)) throw new Error(`Orka does not use the sign-in method "${methodId}" of ${this.spec.label}.`);
    await this.rpc.request('authenticate', { methodId }, { timeoutMs: AUTHENTICATE_TIMEOUT_MS });
  }

  /**
   * Send one prompt and wait for the turn to end. Aborting `signal` sends session/cancel; the
   * agent then ends the turn and answers "cancelled" (the caller decides how long to wait).
   */
  async prompt(sessionId: string, prompt: ContentBlock[], signal?: AbortSignal): Promise<StopReason> {
    const onAbort = () => this.cancel(sessionId);
    if (signal?.aborted) return 'cancelled';
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.rpc.request<{ stopReason?: StopReason }>('session/prompt', { sessionId, prompt });
      return result?.stopReason ?? 'end_turn';
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Ask the agent to end the running turn; it answers the prompt with "cancelled". */
  cancel(sessionId: string): void {
    this.rpc.notify('session/cancel', { sessionId });
  }

  /** Stop the process and everything it started. */
  close(): void {
    this.sessions.clear();
    this.rpc.close();
  }

  private onNotification(method: string, params: any): void {
    if (method !== 'session/update' || !params || typeof params.update !== 'object' || !params.update) return;
    this.sessions.get(params.sessionId)?.update(params.update as SessionUpdate);
  }

  private async onRequest(method: string, params: any): Promise<unknown> {
    const handlers = typeof params?.sessionId === 'string' ? this.sessions.get(params.sessionId) : undefined;
    if (!KNOWN_REQUESTS.has(method)) throw new JsonRpcError(`Method not supported by Orka: ${method}`, RPC_METHOD_NOT_FOUND);
    if (!handlers) throw new JsonRpcError(`Unknown session: ${String(params?.sessionId)}`, ACP_RESOURCE_NOT_FOUND);
    switch (method) {
      case 'session/request_permission':
        if (!params.toolCall || typeof params.toolCall.toolCallId !== 'string' || !Array.isArray(params.options)) throw invalid('toolCall and options');
        return { outcome: await handlers.requestPermission(params) };
      case 'fs/read_text_file':
        if (typeof params.path !== 'string') throw invalid('path');
        return handlers.readTextFile(params);
      case 'fs/write_text_file':
        if (typeof params.path !== 'string' || typeof params.content !== 'string') throw invalid('path and content');
        await handlers.writeTextFile(params);
        return {};
      case 'terminal/create':
        if (typeof params.command !== 'string' || (params.args !== undefined && params.args !== null && !isStringArray(params.args))) throw invalid('command and args');
        return handlers.createTerminal(params);
      case 'terminal/output':
        return handlers.terminalOutput(terminalParams(params));
      case 'terminal/wait_for_exit':
        return handlers.waitForTerminalExit(terminalParams(params));
      case 'terminal/kill':
        handlers.killTerminal(terminalParams(params));
        return {};
      case 'terminal/release':
        handlers.releaseTerminal(terminalParams(params));
        return {};
    }
    return undefined;
  }
}

const KNOWN_REQUESTS = new Set([
  'session/request_permission',
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'terminal/kill',
  'terminal/release',
]);

/** Names of environment variables that carry credentials. */
const CREDENTIAL_NAME = /(key|token|secret|passw(or)?d|credential|auth|cookie|session)/i;

/**
 * Extra environment for an agent without anything that looks like a credential: Orka never hands
 * a vendor's agent a key or token. The agent signs in through its own login.
 */
export function safeEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) if (!CREDENTIAL_NAME.test(name) && typeof value === 'string') out[name] = value;
  return out;
}

/** `promise`, or an AbortError as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function terminalParams(params: any): TerminalParams {
  if (typeof params.terminalId !== 'string') throw invalid('terminalId');
  return params;
}

function invalid(what: string): JsonRpcError {
  return new JsonRpcError(`Invalid params: ${what} missing or of the wrong type.`, RPC_INVALID_PARAMS);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
