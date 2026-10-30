import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import * as path from 'node:path';

/** At start, a longer log is moved to desktop.log.old (replacing the one before). */
const MAX_LOG_BYTES = 512 * 1024;

let file: string | undefined;

/**
 * Orka Desktop's log, <home>/desktop/desktop.log: starts, quits and errors. orka-desktop.exe is a
 * windowed program on Windows (scripts/build-exe.mjs), so what it writes to stdout or stderr goes
 * nowhere unless the caller redirects it; this file is where a failed start can still be read.
 */
export function startLog(logFile: string): void {
  file = logFile;
  try {
    // Private to this user on macOS and Linux (errors can name local paths and projects).
    mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.old`);
  } catch {
    /* appending below creates it, or fails quietly */
  }
  // Monitor only: Node still prints the error and exits as it would without this.
  process.on('uncaughtExceptionMonitor', (error, origin) => log(`${origin}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`));
}

/** The log file, once started. */
export function logFile(): string | undefined {
  return file;
}

/** Anything shaped like an API key (sk-…, sk-ant-…, AIza…, long tokens after "key"/"token") is masked. */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{8,}/g, '$1…')
    .replace(/\b(AIza[0-9A-Za-z_-]{4})[0-9A-Za-z_-]{20,}/g, '$1…')
    .replace(/((?:key|token|secret|password)["']?\s*[:=]\s*["']?)[A-Za-z0-9_.-]{12,}/gi, '$1…');
}

/** One line (or a stack) for the log file, with the time; never throws. */
export function log(text: string): void {
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${redact(text)}\n`, { mode: 0o600 });
  } catch {
    /* a log that cannot be written must not take the app down */
  }
}
