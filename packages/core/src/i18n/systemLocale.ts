import { execFileSync } from 'node:child_process';
import { programPath } from '../host/commands';

let cached: string | undefined;

/**
 * The operating system's language. Inside VS Code, Node's Intl reports VS Code's own display
 * language, so ask the OS: LC_ALL/LANG, the Windows regional setting, or macOS AppleLocale.
 */
export function systemLocale(): string {
  if (cached !== undefined) return cached;
  let locale: string | undefined;
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
  if (env && !/^(C|POSIX)(\.|$)/i.test(env)) locale = env;
  try {
    const reg = !locale && process.platform === 'win32' ? programPath('reg.exe') : undefined;
    if (reg) {
      const out = execFileSync(reg, ['query', 'HKCU\\Control Panel\\International', '/v', 'LocaleName'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      locale = /LocaleName\s+REG_SZ\s+(\S+)/.exec(out)?.[1];
    } else if (!locale && process.platform === 'darwin') {
      locale = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLocale'], { encoding: 'utf8', timeout: 3000 }).trim();
    }
  } catch {
    /* fall back to Intl below */
  }
  cached = locale || Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  return cached;
}
