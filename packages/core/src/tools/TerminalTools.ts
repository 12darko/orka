import { t } from '../i18n';
import { classifyCommand } from '../permissions/commandRisk';
import { gitConfigRisk } from './GitTools';
import type { Tool } from './Tool';
import { ToolError, truncateMiddle } from './Tool';
import { resolveInWorkspace, toRelative } from './workspace';

const MAX_RESULT_CHARS = 30_000;

interface RunCommandInput {
  command: string;
  cwd?: string;
  timeout_seconds?: number;
}

export const runCommandTool: Tool<RunCommandInput> = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace and return its combined output and exit code. ' +
    'Use it to build, type-check, lint, run tests, install dependencies or inspect the environment. ' +
    'Commands must finish on their own - do not start servers, watchers or interactive programs. ' +
    'Risky commands (deletes, git push/reset, publishing...) require the user\'s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute.' },
      cwd: { type: 'string', description: 'Working directory relative to the workspace root (default: root).' },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 1800, description: 'Kill the command after this many seconds.' },
    },
    required: ['command'],
  },
  async describe(input, ctx) {
    const absCwd = resolveInWorkspace(ctx.host.workspaceRoot, input.cwd);
    // Git started by a command is not hardened like Orka's own git calls: any risky repository setting counts.
    const gitRisk = /\bgit\b/i.test(input.command) ? (await gitConfigRisk(ctx.host.workspaceRoot)).join(', ') || undefined : undefined;
    const risk = classifyCommand(input.command, { workspaceRoot: ctx.host.workspaceRoot, cwd: absCwd, gitRisk });
    const cwd = input.cwd ? toRelative(ctx.host.workspaceRoot, absCwd) : '.';
    return {
      category: risk.category,
      risk: risk.risk,
      title: t('Run: {command}', { command: input.command.length > 80 ? `${input.command.slice(0, 77)}...` : input.command }),
      detail: [`$ ${input.command}`, cwd !== '.' ? t('in {cwd}', { cwd }) : '', risk.reason ? t('Risk: {reason}', { reason: t(risk.reason) }) : '']
        .filter(Boolean)
        .join('\n'),
    };
  },
  async execute(input, ctx) {
    if (!input.command.trim()) throw new ToolError('command must not be empty.');
    const cwd = resolveInWorkspace(ctx.host.workspaceRoot, input.cwd);
    if (!(await ctx.host.isDirectory(cwd))) throw new ToolError(`cwd does not exist: ${input.cwd}`);
    const timeoutMs = input.timeout_seconds ? input.timeout_seconds * 1000 : ctx.commandTimeoutMs;
    // Files the command changes are not tracked individually; note that so the model knows.
    const result = await ctx.host.runCommand({ command: input.command, cwd, timeoutMs, signal: ctx.signal, onOutput: ctx.onOutput });
    const output = truncateMiddle(stripAnsi(result.output).trim(), MAX_RESULT_CHARS) || '(no output)';
    if (result.aborted) return { content: `Command was stopped by the user.\n${output}`, isError: true };
    if (result.timedOut) {
      return {
        content: `Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed. Output so far:\n${output}`,
        isError: true,
      };
    }
    const failed = result.exitCode !== 0;
    return { content: `Exit code: ${result.exitCode ?? 'unknown'}\n${output}`, isError: failed };
  },
};

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '');
}
