import { t } from '../i18n';
import { classifyCommand } from '../permissions/commandRisk';
import type { BackgroundProcess } from '../host/processes';
import { stripAnsi } from './TerminalTools';
import type { Tool, ToolContext } from './Tool';
import { ToolError } from './Tool';
import { resolveInWorkspace, toRelative } from './workspace';

const MAX_PROCESSES = 8;
const TAIL_CHARS = 4_000;

interface StartInput {
  command: string;
  name?: string;
  cwd?: string;
  wait_for?: string;
  wait_seconds?: number;
}

function processes(ctx: ToolContext): Map<string, BackgroundProcess> {
  if (!ctx.host.startProcess || !ctx.host.processes) throw new ToolError('This environment cannot run background processes.');
  return ctx.host.processes;
}

function tail(text: string, lines?: number): string {
  let out = stripAnsi(text);
  if (lines) out = out.split(/\r?\n/).slice(-lines).join('\n');
  out = out.trim();
  return out.length > TAIL_CHARS ? `…${out.slice(-TAIL_CHARS)}` : out || '(no output yet)';
}

function statusLine(proc: BackgroundProcess): string {
  const age = Math.round((Date.now() - proc.startedAt) / 1000);
  return proc.running ? `"${proc.name}" is running (pid ${proc.pid ?? '?'}, ${age}s)` : `"${proc.name}" exited with code ${proc.exitCode ?? 'unknown'}`;
}

/** Start a dev server, watcher or other long-running command that must keep running. */
export const startProcessTool: Tool<StartInput> = {
  name: 'start_process',
  description:
    'Start a long-running command in the background - a dev server, a watcher, a local service - that must keep running while ' +
    'you work (run_command is for commands that finish). Returns once the output matches wait_for, the process exits, or ' +
    'wait_seconds pass, with the output so far. Check it later with process_output and stop it with stop_process. ' +
    'To show a web app, start its dev server here, then open_browser its local URL.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line, e.g. "npm run dev".' },
      name: { type: 'string', description: 'Short name to refer to it later (default: derived from the command).' },
      cwd: { type: 'string', description: 'Working directory relative to the workspace root.' },
      wait_for: { type: 'string', description: 'Regular expression that signals it is ready, e.g. "Local:|listening on".' },
      wait_seconds: { type: 'integer', minimum: 1, maximum: 120, description: 'How long to wait before returning (default 10).' },
    },
    required: ['command'],
  },
  describe(input, ctx) {
    const cwd = resolveInWorkspace(ctx.host.workspaceRoot, input.cwd);
    const risk = classifyCommand(input.command, { workspaceRoot: ctx.host.workspaceRoot, cwd });
    return {
      category: risk.category,
      // Starting something that keeps running is never "read-only safe".
      risk: risk.risk === 'safe' ? 'normal' : risk.risk,
      title: t('Start in background: {command}', { command: input.command.length > 70 ? `${input.command.slice(0, 67)}...` : input.command }),
      detail: [`$ ${input.command}`, input.cwd ? t('in {cwd}', { cwd: toRelative(ctx.host.workspaceRoot, cwd) }) : '', risk.reason ? t('Risk: {reason}', { reason: t(risk.reason) }) : '']
        .filter(Boolean)
        .join('\n'),
    };
  },
  async execute(input, ctx) {
    const registry = processes(ctx);
    const name = (input.name?.trim() || input.command.trim().split(/\s+/).slice(0, 3).join(' ')).slice(0, 40);
    const existing = registry.get(name);
    if (existing?.running) throw new ToolError(`A process named "${name}" is already running. Stop it first or choose another name.`);
    if ([...registry.values()].filter((p) => p.running).length >= MAX_PROCESSES) {
      throw new ToolError(`${MAX_PROCESSES} background processes are already running; stop one first.`);
    }
    let pattern: RegExp | undefined;
    if (input.wait_for) {
      try {
        pattern = new RegExp(input.wait_for, 'i');
      } catch {
        throw new ToolError(`wait_for is not a valid regular expression: ${input.wait_for}`);
      }
    }
    const cwd = resolveInWorkspace(ctx.host.workspaceRoot, input.cwd);
    if (!(await ctx.host.isDirectory(cwd))) throw new ToolError(`cwd does not exist: ${input.cwd}`);
    const proc = ctx.host.startProcess!({ name, command: input.command, cwd });
    const waitMs = (input.wait_seconds ?? 10) * 1000;
    const ready = await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        offOutput();
        offExit();
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), waitMs);
      const offOutput = proc.onOutput(() => pattern && pattern.test(stripAnsi(proc.output)) && finish(true));
      const offExit = proc.onExit(() => finish(false));
      const onAbort = () => finish(false);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      if (pattern?.test(stripAnsi(proc.output))) finish(true);
    });
    const how = ready ? 'it printed the ready pattern' : proc.running ? `still running after ${Math.round(waitMs / 1000)}s` : 'it stopped';
    return {
      content: `${statusLine(proc)} - ${how}.\nOutput so far:\n${tail(proc.output)}`,
      isError: !proc.running && proc.exitCode !== 0,
    };
  },
};

/** Read what a background process printed (or list them all). */
export const processOutputTool: Tool<{ name?: string; lines?: number }> = {
  name: 'process_output',
  description: 'Show the status and recent output of a background process started with start_process; without a name, list them all.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The process name.' },
      lines: { type: 'integer', minimum: 1, maximum: 500, description: 'How many of the last lines to show (default 60).' },
    },
  },
  describe: (input) => ({ category: 'read', risk: 'safe', title: input.name ? t('Output of {name}', { name: input.name }) : t('Background processes') }),
  async execute(input, ctx) {
    const registry = processes(ctx);
    if (!input.name) {
      return { content: registry.size ? [...registry.values()].map((p) => `- ${statusLine(p)}: ${p.command}`).join('\n') : 'No background processes.' };
    }
    const proc = registry.get(input.name);
    if (!proc) throw new ToolError(`No background process named "${input.name}". Running: ${[...registry.keys()].join(', ') || 'none'}.`);
    return { content: `${statusLine(proc)}\n${tail(proc.output, input.lines ?? 60)}` };
  },
};

/** Stop a background process (and everything it started). */
export const stopProcessTool: Tool<{ name: string }> = {
  name: 'stop_process',
  description: 'Stop a background process started with start_process, including its child processes.',
  inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The process name.' } }, required: ['name'] },
  describe: (input) => ({ category: 'command', risk: 'safe', title: t('Stop {name}', { name: input.name }) }),
  async execute(input, ctx) {
    const registry = processes(ctx);
    const proc = registry.get(input.name);
    if (!proc) throw new ToolError(`No background process named "${input.name}".`);
    proc.stop();
    registry.delete(input.name);
    return { content: `Stopped "${input.name}".` };
  },
};
