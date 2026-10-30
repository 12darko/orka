import { childEnv, comspec, findExecutable, t } from '@orka/core';
import * as path from 'node:path';

/**
 * A program Orka opens in a terminal for the user (e.g. a vendor's sign-in): its full path and
 * its arguments. The host quotes them itself, so no shell ever looks the program up in the
 * terminal's folder.
 */
export interface TerminalProgram {
  file: string;
  args: readonly string[];
}

/** cmd.exe itself, by its full path (a bare "cmd.exe" is looked up in the current folder first). */
export { comspec };

/**
 * How many cmd.exe read the line. "direct": cmd.exe is the terminal's own program (VS Code) and
 * reads it once, with delayed expansion off (/v:off); inside its quotes & | < > ^ ! are plain
 * characters. "start": another cmd.exe runs `start` first (the desktop app) and reads the
 * program's path outside quotes, so none of those may appear in it.
 */
export type CmdForm = 'direct' | 'start';

/**
 * The program as the line after `cmd.exe /d /s /k`. Every part is quoted, and the whole line once
 * more, since /s drops the first and the last quote. cmd.exe expands percent signs even inside
 * quotes and can't put a quote inside one, so a part it can't take literally is refused, with
 * the command to run by hand.
 */
export function cmdLine(program: TerminalProgram, form: CmdForm = 'start', env: NodeJS.ProcessEnv = process.env): string {
  const refused = form === 'direct' ? /["%\r\n]/ : /["%!&|<>^\r\n]/;
  const parts = [program.file, ...program.args].map((part) => {
    if (refused.test(part)) {
      throw new Error(t('cmd.exe cannot run {part} safely. Run this in a terminal yourself: {command}', { part: JSON.stringify(part), command: typedLine(program, env) }));
    }
    return `"${part}"`;
  });
  return `"${parts.join(' ')}"`;
}

/**
 * The program as the user would type it in a terminal of their own: by its name when PATH finds
 * this very program (a quoted path is no command in PowerShell), else by its path.
 */
function typedLine(program: TerminalProgram, env: NodeJS.ProcessEnv): string {
  const name = path.win32.basename(program.file).replace(/\.(exe|cmd|bat|com)$/i, '');
  const found = findExecutable(name, env, 'win32');
  const byName = !!found && path.win32.resolve(found).toLowerCase() === path.win32.resolve(program.file).toLowerCase();
  return [byName ? name : program.file, ...program.args].map((part) => (/^[\w.:\\/-]+$/.test(part) ? part : `"${part}"`)).join(' ');
}

/** What an editor's terminal (VS Code's createTerminal) needs on top of its name and folder. */
export interface EditorTerminalOptions {
  shellPath?: string;
  shellArgs?: string | string[];
  env?: Record<string, string | undefined>;
  strictEnv?: boolean;
}

/**
 * How the editor opens a terminal for `command`. A line goes to the user's default shell as text;
 * on Windows, cmd.exe there never looks for a program in the terminal's folder. A program runs by
 * its full path in a shell Orka picks, which stays open afterwards, with the editor's own
 * environment only (strictEnv): a workspace's terminal.integrated.env settings and other
 * extensions' terminal variables can't put a folder of theirs on PATH for the "node" a vendor's
 * npm shim starts. Left out are the variables Electron and VS Code set for their own processes
 * (ELECTRON_RUN_AS_NODE would make an Electron program run as Node).
 */
export function editorTerminal(command: string | TerminalProgram, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): EditorTerminalOptions {
  if (typeof command === 'string') return platform === 'win32' ? { env: { NoDefaultCurrentDirectoryInExePath: '1' } } : {};
  const own = childEnv({ ...env }, platform);
  for (const key of Object.keys(own)) if (/^(ELECTRON|VSCODE)_/i.test(key)) delete own[key];
  return platform === 'win32'
    ? { shellPath: comspec(env), shellArgs: `/d /v:off /s /k ${cmdLine(command, 'direct', env)}`, env: own, strictEnv: true }
    : { shellPath: '/bin/sh', shellArgs: ['-c', `${shLine(command)}; exec "\${SHELL:-sh}"`], env: own, strictEnv: true };
}

/**
 * The desktop app's terminal window on Windows: a cmd.exe runs `start`, which opens a console
 * window with another cmd.exe that runs `command` and stays open; `start /wait` returns when the
 * window closes. Both cmd.exe, and whatever the user then types in the window, find programs on
 * PATH only, never in the folder: a repository's freebuff.cmd or npm.cmd must not stand in.
 */
export function terminalWindow(title: string, command: string | TerminalProgram, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const cmd = comspec(env);
  const line = typeof command === 'string' ? `/k ${command}` : `/s /k ${cmdLine(command, 'start', env)}`;
  return { file: cmd, args: ['/d', '/c', `start "${title.replace(/["^&|<>%!]/g, '')}" /wait "${cmd}" /d ${line}`], env: childEnv(env, 'win32') };
}

/** The program as a POSIX shell command line. */
export function shLine(program: TerminalProgram): string {
  return [program.file, ...program.args].map(shQuote).join(' ');
}

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
