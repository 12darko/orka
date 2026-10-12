import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ApprovalRequest, ApprovalResponse, CommandOptions, CommandResult, DirEntry, Host } from './Host';
import { closeBrowser } from '../browser/HeadlessBrowser';
import { BackgroundProcess } from './processes';

export interface NodeHostOptions {
  workspaceRoot: string;
  /** Explicit shell executable; default: PowerShell on Windows, $SHELL or /bin/bash elsewhere. */
  shell?: string;
  ripgrepPath?: string;
  editorName?: string;
  /** Chrome/Edge/Chromium for the browser tool; auto-detected when empty. */
  browserPath?: string;
  approve?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
}

const MAX_CAPTURED_OUTPUT = 400_000;

export class NodeHost implements Host {
  readonly workspaceRoot: string;
  readonly platform = process.platform;
  readonly shellName: string;
  readonly ripgrepPath?: string;
  readonly editorName: string;
  private readonly shellCommand: { file: string; args: (command: string) => string[] };
  readonly processes = new Map<string, BackgroundProcess>();
  readonly browserPath?: string;

  /** Start a long-running process in the shell; it keeps running until stopped (or the host goes away). */
  startProcess(options: { name: string; command: string; cwd: string }): BackgroundProcess {
    const child = spawn(this.shellCommand.file, this.shellCommand.args(options.command), {
      cwd: options.cwd,
      // No CI flag here (dev servers behave differently in CI); don't let tools open browsers on their own.
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' },
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const proc = new BackgroundProcess(options.name, options.command, options.cwd, child);
    this.processes.set(options.name, proc);
    return proc;
  }

  /** Stop every background process (when the workspace or the editor closes). */
  stopAllProcesses(): void {
    for (const proc of this.processes.values()) proc.stop();
    this.processes.clear();
    closeBrowser(this);
  }

  constructor(private readonly options: NodeHostOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.ripgrepPath = options.ripgrepPath;
    this.browserPath = options.browserPath;
    this.editorName = options.editorName ?? 'a code editor';
    this.shellCommand = resolveShell(options.shell);
    this.shellName = path.basename(this.shellCommand.file).replace(/\.exe$/i, '');
  }

  /** Open a URL or file with the operating system's default handler (the browser for web pages). */
  async openUrl(target: string): Promise<void> {
    const [file, args] =
      process.platform === 'win32' ? ['explorer.exe', [target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }

  async readFile(absPath: string): Promise<string> {
    return fs.readFile(absPath, 'utf8');
  }

  async writeFile(absPath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf8');
  }

  async deleteFile(absPath: string): Promise<void> {
    await fs.rm(absPath, { force: true });
  }

  async exists(absPath: string): Promise<boolean> {
    try {
      await fs.access(absPath);
      return true;
    } catch {
      return false;
    }
  }

  async isDirectory(absPath: string): Promise<boolean> {
    try {
      return (await fs.stat(absPath)).isDirectory();
    } catch {
      return false;
    }
  }

  async listDir(absPath: string): Promise<DirEntry[]> {
    const entries = await fs.readdir(absPath, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  }

  async fileSize(absPath: string): Promise<number> {
    return (await fs.stat(absPath)).size;
  }

  runCommand(options: CommandOptions): Promise<CommandResult> {
    return new Promise((resolve) => {
      let output = '';
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const child = spawn(this.shellCommand.file, this.shellCommand.args(options.command), {
        cwd: options.cwd,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI ?? '1' },
        windowsHide: true,
        // Own process group on POSIX so a timeout/stop can kill the whole tree.
        detached: process.platform !== 'win32',
      });

      const append = (data: Buffer) => {
        const text = data.toString('utf8');
        if (output.length < MAX_CAPTURED_OUTPUT) output += text;
        options.onOutput?.(text);
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener('abort', onAbort);
        resolve({ exitCode, output, timedOut, aborted });
      };
      const kill = () => killTree(child.pid);
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);
      const onAbort = () => {
        aborted = true;
        kill();
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort);

      child.on('error', (err) => {
        output += `\n${err.message}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }

  requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    if (this.options.approve) return this.options.approve(request);
    return Promise.resolve({ approved: false, feedback: 'No approval handler is configured.' });
  }
}

function resolveShell(explicit?: string): { file: string; args: (command: string) => string[] } {
  const file = explicit || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash');
  const name = path.basename(file).toLowerCase();
  if (name.startsWith('powershell') || name.startsWith('pwsh')) {
    return {
      file,
      // UTF-8 output so we can decode it reliably, and propagate the real exit code: -Command
      // otherwise reports 1 for any failing native command. The command sits on its own line so
      // a trailing comment in it cannot swallow the epilogue.
      args: (command) => [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [
          "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; $global:LASTEXITCODE=0",
          command,
          '$__ok=$?; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } elseif (-not $__ok) { exit 1 }',
        ].join('\n'),
      ],
    };
  }
  if (name === 'cmd.exe' || name === 'cmd') return { file, args: (command) => ['/d', '/s', '/c', command] };
  return { file, args: (command) => ['-c', command] };
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
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
