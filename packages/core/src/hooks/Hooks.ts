import type { Host } from '../host/Host';
import { stripAnsi } from '../tools/TerminalTools';
import { truncateMiddle } from '../tools/Tool';
import { globToRegExp } from '../tools/workspace';

/** One command the user wants run at a hook point. */
export interface HookCommand {
  /** Shell command, run in the workspace root. In afterEdit hooks `{file}` becomes the edited file's path (quoted). */
  command: string;
  /** afterEdit only: glob(s) the edited file must match, e.g. "*.ts" or "src/**\/*.{ts,tsx}"; empty means every file. */
  match?: string | string[];
  /** Stop the command after this many seconds (default 120). */
  timeoutSeconds?: number;
}

/** Commands run around the agent's work, configured by the user (settings or CLI config). */
export interface HooksConfig {
  /** After each successful file edit by an agent, for the files they match: formatters, single-file linters. */
  afterEdit: HookCommand[];
  /** Before the main agent finishes a request that changed code: lint, type-check, tests. Failures go back to the agent to fix. */
  beforeFinish: HookCommand[];
}

export interface HookResult {
  command: string;
  ok: boolean;
  /** Exit code, "timed out" or "stopped", with the (trimmed) output. */
  summary: string;
  output: string;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_HOOKS = 20;
const MAX_OUTPUT_CHARS = 8_000;
/** Characters that a quoted path cannot carry safely in every shell (PowerShell, cmd, sh). */
const UNSAFE_PATH = /["`$%!\r\n]/;

export const NO_HOOKS: HooksConfig = { afterEdit: [], beforeFinish: [] };

/** Hooks from a settings value; anything malformed is skipped. */
export function readHooks(raw: unknown): HooksConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_HOOKS;
  const list = (value: unknown): HookCommand[] => {
    if (!Array.isArray(value)) return [];
    const out: HookCommand[] = [];
    for (const item of value.slice(0, MAX_HOOKS)) {
      const entry = typeof item === 'string' ? { command: item } : item;
      if (!entry || typeof entry !== 'object' || typeof entry.command !== 'string' || !entry.command.trim()) continue;
      const match = typeof entry.match === 'string' ? entry.match : Array.isArray(entry.match) ? entry.match.filter((m: unknown) => typeof m === 'string') : undefined;
      const timeout = Number(entry.timeoutSeconds);
      out.push({
        command: entry.command.trim(),
        match: match && match.length ? match : undefined,
        timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 3600) : undefined,
      });
    }
    return out;
  };
  const config = raw as Record<string, unknown>;
  return { afterEdit: list(config.afterEdit), beforeFinish: list(config.beforeFinish) };
}

export function hasHooks(hooks: HooksConfig | undefined): boolean {
  return !!hooks && (hooks.afterEdit.length > 0 || hooks.beforeFinish.length > 0);
}

/** afterEdit hooks for a workspace-relative path (forward slashes). */
export function hooksForFile(hooks: readonly HookCommand[], relPath: string): HookCommand[] {
  return hooks.filter((hook) => {
    const globs = hook.match === undefined ? [] : Array.isArray(hook.match) ? hook.match : [hook.match];
    return !globs.length || globs.some((glob) => globToRegExp(glob).test(relPath));
  });
}

/** The command line with `{file}` filled in, or an error when the path cannot be passed safely. */
export function hookCommandLine(hook: HookCommand, relPath?: string): { command: string } | { error: string } {
  if (!hook.command.includes('{file}')) return { command: hook.command };
  if (relPath === undefined) return { error: '{file} is only available in afterEdit hooks' };
  if (UNSAFE_PATH.test(relPath)) return { error: `the path ${relPath} contains characters that cannot be quoted safely` };
  return { command: hook.command.split('{file}').join(`"${relPath}"`) };
}

/** Run one hook in the workspace root. */
export async function runHook(host: Host, hook: HookCommand, signal: AbortSignal, relPath?: string, onOutput?: (chunk: string) => void): Promise<HookResult> {
  const line = hookCommandLine(hook, relPath);
  if ('error' in line) return { command: hook.command, ok: false, summary: `not run: ${line.error}`, output: '' };
  const timeoutMs = (hook.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  let result: Awaited<ReturnType<Host['runCommand']>>;
  try {
    result = await host.runCommand({ command: line.command, cwd: host.workspaceRoot, timeoutMs, signal, onOutput });
  } catch (error) {
    return { command: line.command, ok: false, summary: `could not start: ${error instanceof Error ? error.message : String(error)}`, output: '' };
  }
  const output = truncateMiddle(stripAnsi(result.output).trim(), MAX_OUTPUT_CHARS);
  const summary = result.aborted ? 'stopped' : result.timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit code ${result.exitCode ?? 'unknown'}`;
  return { command: line.command, ok: !result.aborted && !result.timedOut && result.exitCode === 0, summary, output };
}

/** A hook's outcome as the agent sees it. */
export function describeHookResult(point: 'afterEdit' | 'beforeFinish', result: HookResult): string {
  const head = `[Hook ${point}] \`${result.command}\` ${result.ok ? 'passed' : 'FAILED'} (${result.summary})`;
  return result.output && !result.ok ? `${head}:\n${result.output}` : head;
}
