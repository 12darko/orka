import { findBrowser } from '@orka/core';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

function output(file: string, args: string[], env: Record<string, string> = {}): Promise<string | undefined> {
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

/** A web page, file or folder with the system's default app. */
export function openExternal(target: string): Promise<boolean> {
  const [file, args] = process.platform === 'win32' ? ['explorer.exe', [target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  return new Promise((resolve) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/**
 * A new terminal window in `cwd` running `command`, left open for the user; `onClose` when the
 * window is closed (Windows, Linux). The command is Orka's own (e.g. "freebuff"), never model output.
 */
export function openTerminalWindow(options: { title: string; cwd: string; command: string; onClose?: () => void }): void {
  const title = options.title.replace(/["^&|<>%]/g, '');
  let child: ChildProcess;
  if (process.platform === 'win32') {
    // "start /wait" returns when the new console window closes.
    child = spawn('cmd.exe', ['/d', '/c', `start "${title}" /wait cmd.exe /k ${options.command}`], {
      cwd: options.cwd,
      windowsVerbatimArguments: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } else if (process.platform === 'darwin') {
    const script = `cd ${JSON.stringify(options.cwd)} && ${options.command}`;
    child = spawn('osascript', ['-e', 'on run argv', '-e', 'tell application "Terminal" to do script (item 1 of argv)', '-e', 'end run', script], { stdio: 'ignore' });
    child.once('exit', () => undefined); // Terminal.app keeps the window; there is no close signal.
    return;
  } else {
    child = spawn('x-terminal-emulator', ['-e', 'sh', '-c', `${options.command}; exec "\${SHELL:-sh}"`], { cwd: options.cwd, stdio: 'ignore' });
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
