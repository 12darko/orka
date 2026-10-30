import { shLine, shQuote, terminalWindow, type TerminalProgram } from '@orka/app';
import { findBrowser, programPath } from '@orka/core';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

function output(name: string, args: string[], env: Record<string, string> = {}): Promise<string | undefined> {
  const file = programPath(name);
  if (!file) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: 10 * 60_000 }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}

/** PowerShell with Windows Forms (-STA), texts through environment variables, the answer base64-encoded UTF-8. */
async function windowsDialog(script: string, env: Record<string, string>): Promise<string | undefined> {
  const out = await output('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; ${script}`], env);
  const text = out?.trim();
  return text ? Buffer.from(text, 'base64').toString('utf8') : undefined;
}

/** A topmost owner, so the dialog opens in front of Orka's window. */
const OWNER = '$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }';
const ANSWER = '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))';

/** The operating system's folder picker; undefined when cancelled. */
export async function pickFolder(title: string): Promise<string | undefined> {
  let picked: string | undefined;
  if (process.platform === 'win32') {
    picked = await windowsDialog(
      `${OWNER}; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = $env:ORKA_TITLE; $d.ShowNewFolderButton = $true; if ($d.ShowDialog($o) -eq 'OK') { $p = $d.SelectedPath; ${ANSWER} }`,
      { ORKA_TITLE: title },
    );
  } else if (process.platform === 'darwin') {
    picked = (await output('osascript', ['-e', 'on run argv', '-e', 'POSIX path of (choose folder with prompt (item 1 of argv))', '-e', 'end run', title]))?.trim();
  } else {
    picked = (await output('zenity', ['--file-selection', '--directory', `--title=${title}`]))?.trim();
  }
  return picked && existsSync(picked) && statSync(picked).isDirectory() ? picked : undefined;
}

/** The operating system's file picker; undefined when cancelled. */
export async function pickFile(title: string, filters?: Record<string, string[]>): Promise<string | undefined> {
  let picked: string | undefined;
  if (process.platform === 'win32') {
    const filter = [...Object.entries(filters ?? {}).map(([name, exts]) => `${name}|${exts.map((e) => `*.${e}`).join(';')}`), 'All files|*.*'].join('|');
    picked = await windowsDialog(
      `${OWNER}; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = $env:ORKA_TITLE; $d.Filter = $env:ORKA_FILTER; if ($d.ShowDialog($o) -eq 'OK') { $p = $d.FileName; ${ANSWER} }`,
      { ORKA_TITLE: title, ORKA_FILTER: filter },
    );
  } else if (process.platform === 'darwin') {
    picked = (await output('osascript', ['-e', 'on run argv', '-e', 'POSIX path of (choose file with prompt (item 1 of argv))', '-e', 'end run', title]))?.trim();
  } else {
    picked = (await output('zenity', ['--file-selection', `--title=${title}`]))?.trim();
  }
  return picked && existsSync(picked) ? picked : undefined;
}

/** An error in a message box of its own (Windows only), for when there is no Orka window to show it in. */
export async function showErrorBox(title: string, text: string): Promise<void> {
  if (process.platform !== 'win32') return;
  await windowsDialog(`${OWNER}; [void][System.Windows.Forms.MessageBox]::Show($o, $env:ORKA_TEXT, $env:ORKA_TITLE, 'OK', 'Error')`, { ORKA_TITLE: title, ORKA_TEXT: text });
}

/** A web page, file or folder with the system's default app. */
export function openExternal(target: string): Promise<boolean> {
  const file = programPath(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open');
  if (!file) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(file, [target], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/**
 * A new terminal window in `cwd` running `command`, left open for the user; `onClose` when the
 * window is closed (Windows, Linux). The command is Orka's own (e.g. "freebuff"), never model
 * output; a program (a vendor's sign-in) runs by its full path.
 */
export function openTerminalWindow(options: { title: string; cwd: string; command: string | TerminalProgram; onClose?: () => void }): void {
  const { command } = options;
  let child: ChildProcess;
  if (process.platform === 'win32') {
    // windowsHide only hides the cmd that runs "start"; the console window it opens is shown.
    const { file, args, env } = terminalWindow(options.title, command);
    child = spawn(file, args, {
      cwd: options.cwd,
      env,
      windowsVerbatimArguments: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    // The terminal app by its full path: started in the folder, a bare name could be found there.
    const terminal = programPath(process.platform === 'darwin' ? 'osascript' : 'x-terminal-emulator');
    if (!terminal) {
      options.onClose?.();
      return;
    }
    if (process.platform === 'darwin') {
      const script = `cd ${shQuote(options.cwd)} && ${typeof command === 'string' ? command : shLine(command)}`;
      child = spawn(terminal, ['-e', 'on run argv', '-e', 'tell application "Terminal" to do script (item 1 of argv)', '-e', 'end run', script], { stdio: 'ignore' });
      child.once('exit', () => undefined); // Terminal.app keeps the window; there is no close signal.
      return;
    }
    const line = typeof command === 'string' ? command : shLine(command);
    child = spawn(terminal, ['-e', '/bin/sh', '-c', `${line}; exec "\${SHELL:-sh}"`], { cwd: options.cwd, stdio: 'ignore' });
  }
  child.once('error', () => options.onClose?.());
  child.once('exit', () => options.onClose?.());
}

/**
 * Orka's window: Edge, Chrome or Chromium in app mode (no tabs or address bar) with its own
 * profile. Undefined when none is installed.
 */
export function openAppWindow(url: string, profileDir: string, browserPath?: string): ChildProcess | undefined {
  const exe = findBrowser(browserPath);
  if (!exe) return undefined;
  return spawn(exe, [`--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1200,860'], {
    stdio: 'ignore',
    windowsHide: false,
  });
}
