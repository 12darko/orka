import type { Host } from '../host/Host';
import { JsonRpcError } from '../rpc/JsonRpcStdio';
import { ACP_RESOURCE_NOT_FOUND, type TerminalExitStatus, type TerminalOutputResult } from './types';

/** Output kept per terminal when the agent sets no limit. */
const DEFAULT_OUTPUT_LIMIT = 1_000_000;

interface Terminal {
  commandLine: string;
  abort: AbortController;
  output: string;
  truncated: boolean;
  limit: number;
  exit?: TerminalExitStatus;
  done: Promise<TerminalExitStatus>;
}

/**
 * The commands an ACP agent runs through Orka (terminal/*). They run like Orka's own commands, in
 * the host's shell inside the workspace; the session approves each one before it starts here.
 */
export class AcpTerminals {
  private readonly terminals = new Map<string, Terminal>();
  private counter = 0;

  constructor(
    private readonly host: Host,
    private readonly timeoutMs: number,
  ) {}

  /** Start an approved command line; output streams to onOutput. Returns the terminal id. */
  start(commandLine: string, cwd: string, outputByteLimit: number | null | undefined, onOutput: (chunk: string) => void, onExit?: (status: TerminalExitStatus, output: string) => void): string {
    const id = `term_${++this.counter}`;
    const abort = new AbortController();
    const limit = outputByteLimit && outputByteLimit > 0 ? outputByteLimit : DEFAULT_OUTPUT_LIMIT;
    const terminal: Terminal = { commandLine, abort, output: '', truncated: false, limit, done: Promise.resolve({ exitCode: null, signal: null }) };
    terminal.done = this.host
      .runCommand({
        command: commandLine,
        cwd,
        timeoutMs: this.timeoutMs,
        signal: abort.signal,
        onOutput: (chunk) => {
          append(terminal, chunk);
          onOutput(chunk);
        },
      })
      .then(
        (result) => {
          if (result.timedOut) append(terminal, `\n[Orka stopped the command after ${Math.round(this.timeoutMs / 1000)}s]\n`);
          return result.aborted || result.timedOut ? { exitCode: null, signal: 'SIGKILL' } : { exitCode: result.exitCode, signal: null };
        },
        (error: unknown) => {
          append(terminal, `\n${error instanceof Error ? error.message : String(error)}\n`);
          return { exitCode: null, signal: null };
        },
      )
      .then((status) => {
        terminal.exit = status;
        onExit?.(status, terminal.output);
        return status;
      });
    this.terminals.set(id, terminal);
    return id;
  }

  output(id: string): TerminalOutputResult {
    const terminal = this.get(id);
    return { output: terminal.output, truncated: terminal.truncated, exitStatus: terminal.exit ?? null };
  }

  waitForExit(id: string): Promise<TerminalExitStatus> {
    return this.get(id).done;
  }

  /** Stop the command; its output stays readable until release. */
  kill(id: string): void {
    this.get(id).abort.abort();
  }

  /** Stop the command if it still runs and forget it. */
  release(id: string): void {
    this.get(id).abort.abort();
    this.terminals.delete(id);
  }

  /** Stop every command (the user stopped the agent, or the session ends). */
  killAll(): void {
    for (const terminal of this.terminals.values()) terminal.abort.abort();
  }

  private get(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new JsonRpcError(`Unknown terminal: ${id}`, ACP_RESOURCE_NOT_FOUND);
    return terminal;
  }
}

/** Keep the last `limit` bytes of output, cut at a character boundary. */
function append(terminal: Terminal, chunk: string): void {
  terminal.output += chunk;
  if (terminal.output.length <= terminal.limit / 4 || Buffer.byteLength(terminal.output, 'utf8') <= terminal.limit) return;
  const bytes = Buffer.from(terminal.output, 'utf8');
  let start = bytes.length - terminal.limit;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  terminal.output = bytes.subarray(start).toString('utf8');
  terminal.truncated = true;
}

/**
 * The command line for the host's shell: a command with arguments is quoted for that shell (the
 * agent means "run this program with these arguments"); a command without arguments is used as
 * the agent wrote it, since agents often send a whole shell line.
 */
export function commandLine(command: string, args: readonly string[], shellName: string): string {
  if (!args.length) return command;
  const shell = shellName.toLowerCase();
  if (shell.startsWith('powershell') || shell.startsWith('pwsh')) {
    const quote = (s: string) => (/^[\w\-./:=\\]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);
    const program = quote(command);
    // A quoted program name is just a string to PowerShell; the call operator runs it.
    return `${program.startsWith("'") ? '& ' : ''}${program} ${args.map(quote).join(' ')}`;
  }
  if (shell === 'cmd' || shell === 'cmd.exe') {
    const quote = (s: string) => (/^[\w\-./:=\\]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
    return [command, ...args].map(quote).join(' ');
  }
  const quote = (s: string) => (/^[\w\-./:=@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  return [command, ...args].map(quote).join(' ');
}
