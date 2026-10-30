import { spawnSync } from 'node:child_process';
import { programPath } from './commands';

/**
 * Put text on the system clipboard; best effort (false when no clipboard tool is available).
 * ORKA_NO_CLIPBOARD=1 turns it off (tests and CI must not overwrite the user's clipboard).
 */
export function copyToClipboard(text: string): boolean {
  if (process.env.ORKA_NO_CLIPBOARD) return false;
  try {
    if (process.platform === 'win32') {
      const powershell = programPath('powershell.exe');
      if (!powershell) return false;
      // Through an environment variable: Windows passes it as UTF-16, so no code page mangles it.
      const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:ORKA_CLIPBOARD'], {
        env: { ...process.env, ORKA_CLIPBOARD: text },
        windowsHide: true,
        timeout: 10_000,
      });
      return r.status === 0;
    }
    const tools: ReadonlyArray<readonly [string, readonly string[]]> =
      process.platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
    for (const [name, args] of tools) {
      // By full path: a PATH with an empty entry would find the name in the current folder (the CLI's project).
      const file = programPath(name);
      if (file && spawnSync(file, [...args], { input: text, timeout: 5000 }).status === 0) return true;
    }
  } catch {
    /* no clipboard tool */
  }
  return false;
}
