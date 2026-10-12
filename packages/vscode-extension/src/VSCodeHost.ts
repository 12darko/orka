import { type ApprovalRequest, type ApprovalResponse, type BackgroundProcess, type CommandOptions, type CommandResult, NodeHost } from '@orka/core';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentTerminal } from './AgentTerminal';

/**
 * Host adapter for VS Code: file access goes through open editors when a file is open (so
 * unsaved edits are respected and the editor updates in place), commands are mirrored into a
 * terminal, and approvals are delegated to the chat UI.
 */
export class VSCodeHost extends NodeHost {
  constructor(
    workspaceRoot: string,
    shell: string | undefined,
    private readonly terminal: AgentTerminal,
    approve: (request: ApprovalRequest) => Promise<ApprovalResponse>,
    browserPath?: string,
  ) {
    super({ workspaceRoot, shell, ripgrepPath: findRipgrep(), editorName: `VS Code ${vscode.version}`, approve, browserPath });
  }

  /** A background process also gets a read-only terminal, so the user sees what the dev server prints. */
  override startProcess(options: { name: string; command: string; cwd: string }): BackgroundProcess {
    const proc = super.startProcess(options);
    const write = new vscode.EventEmitter<string>();
    const close = new vscode.EventEmitter<number | void>();
    const toTerminal = (text: string) => text.replace(/\r?\n/g, '\r\n');
    const pty: vscode.Pseudoterminal = {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: () => write.fire(toTerminal(`$ ${options.command}\n${proc.output}`)),
      // Closing the terminal stops the process.
      close: () => {
        proc.stop();
        this.processes.delete(options.name);
      },
    };
    const offOutput = proc.onOutput((chunk) => write.fire(toTerminal(chunk)));
    const offExit = proc.onExit((code) => {
      write.fire(toTerminal(`\n[process exited with code ${code ?? 'unknown'}]\n`));
      offOutput();
      offExit();
    });
    vscode.window.createTerminal({ name: `Orka: ${options.name}`, pty, iconPath: new vscode.ThemeIcon('server-process') }).show(true);
    return proc;
  }

  /** Web pages open in the system browser (or VS Code's Simple Browser); files with their default app. */
  override async openUrl(target: string, options: { inEditor?: boolean } = {}): Promise<void> {
    const web = /^https?:\/\//i.test(target);
    if (web && options.inEditor) {
      try {
        await vscode.commands.executeCommand('simpleBrowser.show', target);
        return;
      } catch {
        /* Simple Browser disabled: fall back to the system browser */
      }
    }
    const opened = await vscode.env.openExternal(web ? vscode.Uri.parse(target) : vscode.Uri.file(target));
    if (!opened) throw new Error('The page was not opened (the user may have cancelled).');
  }

  /** Show a file in an editor tab; Markdown can open as its rendered preview. */
  async openInEditor(absPath: string, options: { preview?: boolean } = {}): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    if (options.preview && /\.(md|markdown)$/i.test(absPath)) {
      await vscode.commands.executeCommand('markdown.showPreview', uri);
      return;
    }
    await vscode.window.showTextDocument(uri, { preview: false });
  }

  override async readFile(absPath: string): Promise<string> {
    const doc = findOpenDocument(absPath);
    if (doc?.isDirty) return doc.getText();
    return super.readFile(absPath);
  }

  override async writeFile(absPath: string, content: string): Promise<void> {
    const doc = findOpenDocument(absPath);
    if (!doc) return super.writeFile(absPath, content);
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(doc.uri, fullRange, content);
    if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) {
      // Fall back to the disk if the editor refused (e.g. read-only document).
      await super.writeFile(absPath, content);
    }
  }

  override async runCommand(options: CommandOptions): Promise<CommandResult> {
    const rel = path.relative(this.workspaceRoot, options.cwd) || '.';
    this.terminal.commandStarted(options.command, rel);
    const result = await super.runCommand({
      ...options,
      onOutput: (chunk) => {
        this.terminal.output(chunk);
        options.onOutput?.(chunk);
      },
    });
    this.terminal.commandFinished(result.exitCode, result.timedOut);
    return result;
  }
}

function findOpenDocument(absPath: string): vscode.TextDocument | undefined {
  const target = normalize(absPath);
  return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && normalize(d.uri.fsPath) === target);
}

function normalize(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** VS Code ships ripgrep; use it for fast code search when we can find it. */
function findRipgrep(): string | undefined {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = [
    path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
    path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
    path.join(vscode.env.appRoot, 'node_modules', 'vscode-ripgrep', 'bin', exe),
    path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', 'vscode-ripgrep', 'bin', exe),
  ];
  return candidates.find((c) => existsSync(c));
}
