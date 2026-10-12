import { spawnSync } from 'node:child_process';

/**
 * Put text on the system clipboard; best effort (false when no clipboard tool is available).
 * ORKA_NO_CLIPBOARD=1 turns it off (tests and CI must not overwrite the user's clipboard).
 */
export function copyToClipboard(text: string): boolean {
  if (process.env.ORKA_NO_CLIPBOARD) return false;
  try {
    if (process.platform === 'win32') {
      // Through an environment variable: Windows passes it as UTF-16, so no code page mangles it.
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:ORKA_CLIPBOARD'], {
        env: { ...process.env, ORKA_CLIPBOARD: text },
        windowsHide: true,
        timeout: 10_000,
      });
      return r.status === 0;
    }
    if (process.platform === 'darwin') return spawnSync('pbcopy', [], { input: text, timeout: 5000 }).status === 0;
    for (const [cmd, args] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]] as const) {
      if (spawnSync(cmd, [...args], { input: text, timeout: 5000 }).status === 0) return true;
    }
  } catch {
    /* no clipboard tool */
  }
  return false;
}
