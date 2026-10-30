import type { SecretStore } from '@orka/app';
import { programPath, shellEnv } from '@orka/core';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const SERVICE = 'Orka';

function run(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<string> {
  const started = Date.now();
  const debug = (line: string) => process.env.ORKA_DEBUG && console.error(`[orka] ${path.basename(file)}: ${line} after ${Date.now() - started} ms`);
  return new Promise((resolve, reject) => {
    // Generous: the first PowerShell start on a cold or busy machine can take well over 20 seconds.
    const child = execFile(file, args, { env: options.env ?? process.env, windowsHide: true, timeout: 90_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      // Node's own message repeats the command line, and on macOS that holds the secret: never pass it on.
      const why = error ? `${path.basename(file)} failed (${error.killed ? 'timed out' : (error.code ?? error.signal ?? 'error')})` : '';
      debug(error ? `${why}; ${stderr.trim().slice(0, 300)}` : 'done');
      if (error) reject(new Error(stderr.trim() || why));
      else resolve(stdout);
    });
    // Always close stdin: PowerShell can wait for the end of a redirected input before it exits.
    child.stdin?.end(options.input ?? '');
  });
}

/** PowerShell with the value in an environment variable: never on a command line, and UTF-16 safe. */
function powershell(script: string, env: Record<string, string>): Promise<string> {
  const file = programPath('powershell.exe');
  if (!file) return Promise.reject(new Error('powershell.exe was not found.'));
  return run(file, ['-NoProfile', '-NonInteractive', '-Command', script], { env: shellEnv(file, env) });
}

const PROTECT = 'ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $env:ORKA_SECRET -AsPlainText -Force)';
const UNPROTECT =
  '$s = ConvertTo-SecureString -String $env:ORKA_BLOB; ' +
  '$p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); ' +
  // try and finally must not be separated by ";".
  'try { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))) } ' +
  'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }';

/**
 * API keys in the operating system's protected storage: Windows DPAPI (encrypted for this user,
 * kept in a file next to the settings), the macOS Keychain, or the Secret Service on Linux.
 */
export class OsSecretStore implements SecretStore {
  private readonly cache = new Map<string, string | undefined>();

  /** `file`: where Windows keeps the DPAPI-encrypted values. */
  constructor(private readonly file: string) {}

  async get(key: string): Promise<string | undefined> {
    if (this.cache.has(key)) return this.cache.get(key);
    let value: string | undefined;
    if (process.platform === 'win32') {
      const blob = this.blobs()[key];
      value = blob ? Buffer.from((await powershell(UNPROTECT, { ORKA_BLOB: blob })).trim(), 'base64').toString('utf8') : undefined;
    } else if (process.platform === 'darwin') {
      value = (await run('security', ['find-generic-password', '-s', SERVICE, '-a', key, '-w']).catch(() => '')).trim() || undefined;
    } else {
      value = (await run('secret-tool', ['lookup', 'service', SERVICE, 'account', key]).catch(() => '')).trim() || undefined;
    }
    this.cache.set(key, value);
    return value;
  }

  async store(key: string, value: string): Promise<void> {
    if (process.platform === 'win32') {
      const blob = (await powershell(PROTECT, { ORKA_SECRET: value })).trim();
      if (!/^[0-9a-f]+$/i.test(blob)) throw new Error('Windows could not protect the key.');
      this.writeBlobs({ ...this.blobs(), [key]: blob });
    } else if (process.platform === 'darwin') {
      await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', key, '-w', value]);
    } else {
      await run('secret-tool', ['store', `--label=${SERVICE}: ${key}`, 'service', SERVICE, 'account', key], { input: value }).catch((error: Error) => {
        throw new Error(`No secure storage available (${error.message}). Set the key as an environment variable instead.`);
      });
    }
    this.cache.set(key, value);
  }

  async delete(key: string): Promise<void> {
    if (process.platform === 'win32') {
      const blobs = this.blobs();
      delete blobs[key];
      this.writeBlobs(blobs);
    } else if (process.platform === 'darwin') {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', key]).catch(() => undefined);
    } else {
      await run('secret-tool', ['clear', 'service', SERVICE, 'account', key]).catch(() => undefined);
    }
    this.cache.set(key, undefined);
  }

  private blobs(): Record<string, string> {
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return data && typeof data === 'object' ? (data as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private writeBlobs(blobs: Record<string, string>): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(blobs, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
