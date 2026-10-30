import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Finding and starting programs the user installed (MCP servers, hand-off agents, ACP agents):
 * one place for the PATH lookup and for the Windows rules around .cmd shims.
 */

/**
 * Full path of an executable on PATH, or undefined. On Windows only PATHEXT files run (npm puts
 * an extensionless shell script for Git Bash next to "freebuff.cmd"; that one cannot be started).
 */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      for (const name of new Set([command + ext.toLowerCase(), command + ext])) {
        const full = path.join(dir, name);
        if (existsSync(full)) return full;
      }
    }
  }
  return undefined;
}

/**
 * On Windows, commands like npx or uvx are .cmd shims that spawn() cannot start directly; run
 * those through the shell with quoted arguments. Executables and absolute paths start directly.
 */
export function resolveCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') return { file: command, args, shell: false };
  // Look the command up like the shell would, so a program (uvx.exe) starts directly.
  const file = /[\\/]/.test(command) ? command : (findExecutable(command, env, platform) ?? command);
  if (/\.(exe|com)$/i.test(file)) return { file, args, shell: false };
  return { file: file.replace(CMD_META, '^$1'), args: args.map(cmdArgument), shell: true };
}

/** Characters cmd.exe treats specially; a caret makes each one literal. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for a batch file (npx.cmd, uvx.cmd, ...) started through cmd.exe, by the rules
 * cross-spawn uses for such shims: quoted for the program's own argument parsing (backslashes
 * before a quote doubled, the quote escaped), then cmd.exe's special characters escaped twice,
 * because cmd parses the line once and again when the batch file passes %* on.
 */
export function cmdArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}
