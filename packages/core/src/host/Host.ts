import type { PermissionCategory, RiskLevel } from '../permissions/PermissionManager';
import type { BackgroundProcess } from './processes';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface CommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface ApprovalRequest {
  /** Tool call id - unique per request. */
  id: string;
  toolName: string;
  category: PermissionCategory;
  risk: RiskLevel;
  title: string;
  detail?: string;
  /** Proposed file content change, so front-ends can show a diff before approving. */
  preview?: { path: string; before: string | null; after: string | null };
}

export interface ApprovalResponse {
  approved: boolean;
  /** Optional guidance from the user, passed back to the model (e.g. "use a different name"). */
  feedback?: string;
  /** Allow this kind of action for the rest of the session. */
  alwaysAllow?: boolean;
}

/**
 * Everything the core needs from its environment. The VS Code adapter, the future desktop app
 * and a CLI each provide one; `NodeHost` is a complete default built on Node's fs/child_process.
 */
export interface Host {
  readonly workspaceRoot: string;
  readonly platform: NodeJS.Platform;
  /** Human-readable shell name, shown to the model so it writes the right syntax. */
  readonly shellName: string;
  /** Path to a ripgrep binary if one is available (faster code search). */
  readonly ripgrepPath?: string;
  readonly editorName: string;

  /**
   * Show a web page or a local file (e.g. an HTML page) to the user in a browser. `inEditor`
   * asks for a browser inside the editor when there is one. Optional: hosts without a UI omit it.
   */
  openUrl?(target: string, options?: { inEditor?: boolean }): Promise<void>;
  /** Show a file to the user in the editor (`preview`: rendered view, e.g. Markdown). Optional. */
  openInEditor?(absPath: string, options?: { preview?: boolean }): Promise<void>;
  /** Start a long-running process (dev server, watcher) that outlives the tool call. Optional. */
  startProcess?(options: { name: string; command: string; cwd: string }): BackgroundProcess;
  /** Chrome/Edge/Chromium executable for the browser tool (auto-detected when empty). */
  readonly browserPath?: string;
  /** Processes started with startProcess, by name. */
  readonly processes?: Map<string, BackgroundProcess>;

  readFile(absPath: string): Promise<string>;
  writeFile(absPath: string, content: string): Promise<void>;
  deleteFile(absPath: string): Promise<void>;
  exists(absPath: string): Promise<boolean>;
  isDirectory(absPath: string): Promise<boolean>;
  listDir(absPath: string): Promise<DirEntry[]>;
  fileSize(absPath: string): Promise<number>;
  runCommand(options: CommandOptions): Promise<CommandResult>;
  requestApproval(request: ApprovalRequest): Promise<ApprovalResponse>;
}
