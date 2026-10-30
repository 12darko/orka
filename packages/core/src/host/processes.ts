import { type ChildProcess, spawnSync } from 'node:child_process';
import { programPath } from './commands';

const MAX_OUTPUT = 200_000;

/**
 * A long-running process the agent started (a dev server, a watcher): it keeps running across
 * tool calls and requests, and its recent output can be read at any time.
 */
export class BackgroundProcess {
  private text = '';
  /** undefined while running; the exit code (null when killed by a signal) afterwards. */
  exitCode: number | null | undefined = undefined;
  readonly startedAt = Date.now();
  private readonly outputListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();

  constructor(
    readonly name: string,
    readonly command: string,
    readonly cwd: string,
    private readonly child: ChildProcess,
  ) {
    const append = (data: Buffer) => this.append(data.toString('utf8'));
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (error) => this.append(`\n${error.message}\n`));
    child.on('close', (code) => {
      this.exitCode = code;
      for (const listener of this.exitListeners) listener(code);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return this.exitCode === undefined;
  }

  get output(): string {
    return this.text;
  }

  onOutput(listener: (chunk: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  stop(): void {
    if (!this.running) return;
    killTree(this.child.pid);
  }

  private append(chunk: string): void {
    this.text = (this.text + chunk).slice(-MAX_OUTPUT);
    for (const listener of this.outputListeners) listener(chunk);
  }
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const taskkill = programPath('taskkill.exe');
      if (taskkill) spawnSync(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      else process.kill(pid, 'SIGKILL');
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
