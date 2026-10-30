import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Finding and starting programs: the ones the user installed (MCP servers, hand-off agents, ACP
 * agents) and the ones Orka itself starts (git, the shell). One place for the PATH lookup and for
 * the Windows rules around the current folder and .cmd shims.
 */

/**
 * Full path of an executable on PATH, or undefined. On Windows only PATHEXT files run (npm puts
 * an extensionless shell script for Git Bash next to "freebuff.cmd"; that one cannot be started);
 * a name that already has one ("node.exe", "agent.cmd") is found as it is. Relative PATH entries
 * are skipped: they would find a program in the current folder (a workspace) before PATH.
 */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const pathExts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = pathExts.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()));
  const exts = platform === 'win32' ? [...(hasExt ? [''] : []), ...pathExts] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
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
 * The environment for a program Orka starts. On Windows, cmd.exe (which runs .cmd shims) and the
 * "node" an npm shim starts by bare name would look in the current folder, the workspace, before
 * PATH: a node.cmd a repository ships would run. NoDefaultCurrentDirectoryInExePath turns that
 * lookup off for the program and everything it starts.
 */
export function childEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return platform === 'win32' ? { ...env, NoDefaultCurrentDirectoryInExePath: '1' } : env;
}

/**
 * At the start of Orka's own process (the desktop app, the CLI), on Windows: no program Orka or
 * its children start by bare name comes from the current folder. Node decides where a bare name
 * is looked up by the parent's environment, not the child's, so childEnv alone can't do this.
 * Never in a process Orka shares with others (VS Code's extension host).
 */
export function hardenProgramLookup(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1';
}

/** cmd.exe by its full path (a bare "cmd.exe" is looked up in the current folder first). */
export function comspec(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ComSpec ?? env.COMSPEC;
  return configured && path.win32.isAbsolute(configured) ? configured : path.win32.join(systemRoot(env), 'System32', 'cmd.exe');
}

function systemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
}

/** Programs that come with Windows, by their place in the Windows folder. */
const WINDOWS_PROGRAMS: Readonly<Record<string, string>> = {
  'powershell.exe': 'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'explorer.exe': 'explorer.exe',
  'reg.exe': 'System32\\reg.exe',
  'taskkill.exe': 'System32\\taskkill.exe',
};

/** Programs found on PATH, by platform, name and PATH. */
const found = new Map<string, string>();

/**
 * The full path of a program Orka itself starts (git, the shell, Windows' own tools), or undefined
 * when it is not installed. Never the bare name: Node looks that up in the child's working folder
 * (often the workspace) before PATH. Windows' own programs come from the Windows folder, the rest
 * from PATH (absolute entries only; on Windows only .exe and .com, which start without a shell). A
 * name with a path in it is taken as it is.
 */
export function programPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (/[\\/]/.test(name)) return name;
  if (platform === 'win32') {
    const exe = /\.exe$/i.test(name) ? name.toLowerCase() : `${name.toLowerCase()}.exe`;
    if (exe === 'cmd.exe') return comspec(env);
    const own = WINDOWS_PROGRAMS[exe] && path.win32.join(systemRoot(env), WINDOWS_PROGRAMS[exe]);
    if (own && existsSync(own)) return own;
  }
  const PATH = env.PATH ?? env.Path ?? '';
  const key = `${platform}\0${name}\0${PATH}`;
  const cached = found.get(key);
  // One stat instead of a walk through PATH; an uninstalled program is looked up again.
  if (cached && existsSync(cached)) return cached;
  const file = findExecutable(name, platform === 'win32' ? { PATH, PATHEXT: '.COM;.EXE' } : env, platform);
  // Only what was found is remembered: a program installed later is found then.
  if (file) found.set(key, file);
  else found.delete(key);
  return file;
}

/**
 * On Windows, commands like npx or uvx are .cmd shims that spawn() cannot start directly; run
 * those through cmd.exe with quoted arguments. Executables found on PATH or named by a path
 * start directly. cmd.exe is named by its full path: with `shell: true`, Node would start a bare
 * "cmd.exe" (looked up in the working folder first) whenever ComSpec is unset.
 */
export function resolveCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; shell: string | false } {
  if (platform !== 'win32') return { file: command, args, shell: false };
  // Look the command up like the shell would, so a program (uvx.exe) starts directly. One that is
  // not on PATH goes to cmd.exe, which the child's environment keeps out of the current folder;
  // started directly, Node would look for it there first.
  const located = /[\\/]/.test(command) ? command : findExecutable(command, env, platform);
  if (located && /\.(exe|com)$/i.test(located)) return { file: located, args, shell: false };
  return { file: (located ?? command).replace(CMD_META, '^$1'), args: args.map(cmdArgument), shell: comspec(env) };
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
  // A loop, not a regex: a long run of backslashes must stay linear.
  let quoted = '"';
  let slashes = 0;
  for (const c of arg) {
    if (c === '\\') {
      slashes++;
      continue;
    }
    quoted += '\\'.repeat(c === '"' ? slashes * 2 + 1 : slashes) + c;
    slashes = 0;
  }
  quoted += `${'\\'.repeat(slashes * 2)}"`;
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}
