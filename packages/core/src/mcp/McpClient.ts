import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { childEnv, resolveCommand } from '../host/commands';
import type { JsonSchema } from '../types';
import { VERSION } from '../version';

export { resolveCommand } from '../host/commands';

/**
 * A minimal Model Context Protocol client over stdio (newline-delimited JSON-RPC 2.0): enough to
 * start a server, list its tools and call them. That covers the MCP servers people run locally
 * (Unity MCP, Blender MCP, filesystem, databases, ...).
 */
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/** A local server started as a child process, speaking JSON-RPC over stdin/stdout. */
export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Kept in the configuration but not started. */
  disabled?: boolean;
}

/** A server reached over Streamable HTTP (e.g. Unity MCP at http://localhost:8080/mcp). */
export interface McpHttpConfig {
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export function isHttpConfig(config: McpServerConfig): config is McpHttpConfig {
  return typeof (config as McpHttpConfig).url === 'string';
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

export type McpState = 'idle' | 'starting' | 'ready' | 'error' | 'closed';

const PROTOCOL_VERSION = '2025-06-18';
const START_TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 40_000;

export class McpClient {
  state: McpState = 'idle';
  error?: string;
  tools: McpToolInfo[] = [];
  serverName?: string;
  private child?: ChildProcessWithoutNullStreams;
  /** Streamable HTTP session, assigned by the server on initialize. */
  private sessionId?: string;
  private buffer = '';
  private stderrTail = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private starting?: Promise<void>;

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    private readonly clientInfo = { name: 'orka', version: VERSION },
  ) {}

  /** Start the server (once), do the handshake and load its tool list. */
  start(timeoutMs = START_TIMEOUT_MS): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.doStart(timeoutMs).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async doStart(timeoutMs: number): Promise<void> {
    this.state = 'starting';
    this.error = undefined;
    try {
      if (!isHttpConfig(this.config)) {
        const config = this.config;
        const { file, args, shell } = resolveCommand(config.command, config.args ?? []);
        this.child = spawn(file, args, {
          cwd: config.cwd,
          env: childEnv({ ...process.env, ...(config.env ?? {}) }),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell,
        });
        this.child.stdout.on('data', (data: Buffer) => this.onData(data.toString('utf8')));
        this.child.stderr.on('data', (data: Buffer) => (this.stderrTail = (this.stderrTail + data.toString('utf8')).slice(-2000)));
        this.child.on('error', (error) => this.fail(`could not start "${config.command}": ${error.message}`));
        this.child.on('exit', (code) => this.fail(`the server exited (code ${code})${this.stderrTail.trim() ? `: ${lastLines(this.stderrTail)}` : ''}`));
        this.child.stdin.on('error', () => {
          /* reported through exit */
        });
      }
      const init = await this.request(
        'initialize',
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo },
        timeoutMs,
      );
      this.serverName = init?.serverInfo?.name;
      this.notify('notifications/initialized');
      this.tools = await this.listTools(timeoutMs);
      this.state = 'ready';
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      throw new Error(`MCP server "${this.name}": ${this.error}`);
    }
  }

  private async listTools(timeoutMs: number): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs);
      for (const tool of result?.tools ?? []) if (tool && typeof tool.name === 'string') tools.push(tool);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<McpCallResult> {
    await this.start();
    const onAbort = () => this.notify('notifications/cancelled', { requestId: this.nextId - 1, reason: 'The user stopped the agent.' });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.request('tools/call', { name, arguments: args }, timeoutMs, signal);
      return { content: renderContent(result), isError: !!result?.isError };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const { reject } of this.pending.values()) reject(new Error('MCP server closed.'));
    this.pending.clear();
    const pid = this.child?.pid;
    this.child?.removeAllListeners();
    if (pid) {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        else this.child?.kill();
      } catch {
        /* already gone */
      }
    }
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    if (this.state === 'error' || this.state === 'closed') return Promise.reject(new Error(this.error ?? 'not running'));
    if (isHttpConfig(this.config)) return this.httpRequest({ jsonrpc: '2.0', id: this.nextId++, method, params }, timeoutMs, signal);
    if (!this.child) return Promise.reject(new Error('not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        this.pending.delete(id);
        fn();
      };
      signal?.addEventListener('abort', () => done(() => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))), { once: true });
      this.pending.set(id, { resolve: (v) => done(() => resolve(v)), reject: (e) => done(() => reject(e)) });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    const message = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    if (isHttpConfig(this.config)) void this.httpRequest(message, 10_000).catch(() => undefined);
    else this.write(message);
  }

  /** Fire-and-forget POST (responses to server requests). */
  private httpPost(body: unknown): void {
    const config = this.config as McpHttpConfig;
    void fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }

  /** Streamable HTTP: POST each message; the answer comes back as JSON or as a server-sent event stream. */
  private async httpRequest(message: { jsonrpc: string; id?: number; method: string; params?: unknown }, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    const config = this.config as McpHttpConfig;
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(message),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    }).catch((error: unknown) => {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      const cause = (error as { cause?: { code?: string } })?.cause?.code;
      throw new Error(`could not reach ${config.url}${cause ? ` (${cause})` : ''} - is the server running?`);
    });
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (message.id === undefined) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${config.url}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    const type = response.headers.get('content-type') ?? '';
    const messages: any[] = [];
    if (type.includes('text/event-stream')) {
      // Read events until the answer to this request arrives.
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = text.search(/\r?\n\r?\n/)) >= 0) {
          const event = text.slice(0, boundary);
          text = text.slice(boundary).replace(/^\r?\n\r?\n/, '');
          const data = event
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (data) {
            try {
              messages.push(JSON.parse(data));
            } catch {
              /* not JSON */
            }
          }
        }
        if (messages.some((m) => m?.id === message.id && !m.method)) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    } else {
      const body = await response.json();
      messages.push(...(Array.isArray(body) ? body : [body]));
    }
    // Answer pings the server sent along; other server requests are not supported by this client.
    for (const m of messages) if (m?.method === 'ping' && m.id !== undefined) this.httpPost({ jsonrpc: '2.0', id: m.id, result: {} });
    const answer = messages.find((m) => m?.id === message.id && !m.method);
    if (!answer) throw new Error(`no answer to ${message.method}`);
    if (answer.error) throw new Error(answer.error.message ?? 'MCP error');
    return answer.result;
  }

  private write(message: unknown): void {
    try {
      this.child?.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* reported through exit */
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // servers sometimes log to stdout
      }
      this.handle(message);
    }
  }

  private handle(message: any): void {
    if (message.id !== undefined && message.method) {
      // A request from the server: answer pings, decline everything else (sampling, roots, ...).
      if (message.method === 'ping') this.write({ jsonrpc: '2.0', id: message.id, result: {} });
      else this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not supported by this client: ${message.method}` } });
      return;
    }
    if (message.id === undefined) return; // notifications (logging, list_changed) are not needed here
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    if (message.error) pending.reject(new Error(message.error.message ?? 'MCP error'));
    else pending.resolve(message.result);
  }

  private fail(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'error';
    this.error = reason;
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
  }
}

/** MCP tool result content as text for the model. */
function renderContent(result: any): string {
  const parts: string[] = [];
  for (const item of result?.content ?? []) {
    if (item?.type === 'text') parts.push(String(item.text ?? ''));
    else if (item?.type === 'image') parts.push(`[image: ${item.mimeType ?? 'unknown type'}]`);
    else if (item?.type === 'audio') parts.push(`[audio: ${item.mimeType ?? 'unknown type'}]`);
    else if (item?.type === 'resource') parts.push(item.resource?.text ?? `[resource ${item.resource?.uri ?? ''}]`);
    else if (item?.type === 'resource_link') parts.push(`[resource ${item.uri ?? ''}]`);
  }
  if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  const text = parts.join('\n').trim() || '(no output)';
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… [${text.length - MAX_RESULT_CHARS} more chars]` : text;
}

function lastLines(text: string): string {
  return text.trim().split(/\r?\n/).slice(-3).join(' ');
}
