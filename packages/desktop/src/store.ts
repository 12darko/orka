import type { Disposable, SettingsStore, StateStore } from '@orka/app';
import { type FSWatcher, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { log } from './log';

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
  } catch {
    return {};
  }
}

/** Write through a temporary file, so a crash never leaves half a file behind. */
function writeJson(file: string, data: Json): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameOver(tmp, file);
}

/**
 * Windows refuses to replace a file another program has open for a moment (a virus scanner or the
 * search indexer looking at the file just written): try again for about a second before giving up.
 */
function renameOver(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 12 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * attempt);
    }
  }
}

/**
 * The desktop app's settings: one flat JSON object with the same keys as the VS Code extension's
 * "orka.*" settings ("claudeCode.model", "permissionMode", ...). Edits made to the file by
 * hand apply right away.
 */
export class JsonSettings implements SettingsStore, Disposable {
  private data: Json;
  private readonly listeners = new Set<() => void>();
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;

  constructor(readonly file: string) {
    this.data = readJson(file);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      this.watcher = watch(path.dirname(file), (_event, name) => {
        if (name === path.basename(file)) this.scheduleReload();
      });
    } catch {
      /* no file watching here: changes made in the app still apply */
    }
  }

  get<T>(key: string, fallback: T): T {
    const value = this.data[key];
    return value === undefined || value === null ? fallback : (value as T);
  }

  isSet(key: string): boolean {
    return this.data[key] !== undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    writeJson(this.file, this.data);
    this.fire();
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Make sure the file exists (to open it for editing). */
  ensureFile(defaults: Json = {}): void {
    for (const [key, value] of Object.entries(defaults)) if (this.data[key] === undefined) this.data[key] = value;
    writeJson(this.file, this.data);
  }

  private scheduleReload(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const next = readJson(this.file);
      if (JSON.stringify(next) === JSON.stringify(this.data)) return; // our own write
      this.data = next;
      this.fire();
    }, 150);
  }

  private fire(): void {
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.listeners.clear();
  }
}

/** Remembered state (recent folders, model list cache, MCP trust...) in one JSON file, in named scopes. */
export class JsonState {
  private readonly data: Json;

  constructor(private readonly file: string) {
    this.data = readJson(file);
  }

  scope(name: string): StateStore {
    const bucket = (): Json => {
      const current = this.data[name];
      if (current && typeof current === 'object' && !Array.isArray(current)) return current as Json;
      const created: Json = {};
      this.data[name] = created;
      return created;
    };
    return {
      get: <T>(key: string, fallback?: T) => (bucket()[key] as T | undefined) ?? (fallback as T),
      update: async (key: string, value: unknown) => {
        if (value === undefined) delete bucket()[key];
        else bucket()[key] = value;
        // Remembered state is a convenience: the value stays in memory, and the next write saves it.
        try {
          writeJson(this.file, this.data);
        } catch (error) {
          log(`Could not save ${path.basename(this.file)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    } as StateStore;
  }
}
