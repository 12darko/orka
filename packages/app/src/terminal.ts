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
export function comspec(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ComSpec ?? env.COMSPEC;
  return configured && path.win32.isAbsolute(configured) ? configured : path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
}

/**
 * The program as the line after `cmd.exe /d /s /k`. Every part is quoted, and the whole line once
 * more, since /s drops the first and the last quote. cmd.exe can't take quotes, percent and
 * exclamation marks or its operators literally in every place this line passes through, so a
 * part with one of those is refused.
 */
export function cmdLine(program: TerminalProgram): string {
  const parts = [program.file, ...program.args].map((part) => {
    if (/["%!&|<>^\r\n]/.test(part)) throw new Error(`cmd.exe can't run ${JSON.stringify(part)} safely.`);
    return `"${part}"`;
  });
  return `"${parts.join(' ')}"`;
}

/** The program as a POSIX shell command line. */
export function shLine(program: TerminalProgram): string {
  return [program.file, ...program.args].map(shQuote).join(' ');
}

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
