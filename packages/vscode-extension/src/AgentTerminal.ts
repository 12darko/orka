import * as vscode from 'vscode';

/**
 * A read-only "Orka" terminal that mirrors every command the agent runs and its
 * output, so the user can follow along in the familiar terminal panel.
 */
export class AgentTerminal implements vscode.Disposable {
  private terminal?: vscode.Terminal;
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private opened = false;
  private buffer = '';
  private shownOnce = false;
  private readonly closeListener: vscode.Disposable;

  constructor() {
    this.closeListener = vscode.window.onDidCloseTerminal((t) => {
      if (t === this.terminal) {
        this.terminal = undefined;
        this.opened = false;
        this.shownOnce = false;
      }
    });
  }

  commandStarted(command: string, cwd: string): void {
    this.ensure();
    this.write(`\x1b[36m${cwd}\x1b[0m\r\n\x1b[1m$ ${command}\x1b[0m\r\n`);
    if (!this.shownOnce) {
      this.terminal?.show(true);
      this.shownOnce = true;
    }
  }

  output(chunk: string): void {
    this.write(chunk.replace(/\r?\n/g, '\r\n'));
  }

  commandFinished(exitCode: number | null, timedOut: boolean): void {
    const status = timedOut ? '\x1b[33mtimed out\x1b[0m' : exitCode === 0 ? '\x1b[32mexit 0\x1b[0m' : `\x1b[31mexit ${exitCode}\x1b[0m`;
    this.write(`\r\n[${status}]\r\n\r\n`);
  }

  private ensure(): void {
    if (this.terminal) return;
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writeEmitter.event,
      open: () => {
        this.opened = true;
        this.writeEmitter.fire('\x1b[2mCommands run by the AI agent appear here (read-only).\x1b[0m\r\n\r\n');
        if (this.buffer) {
          this.writeEmitter.fire(this.buffer);
          this.buffer = '';
        }
      },
      close: () => {
        this.opened = false;
      },
    };
    this.terminal = vscode.window.createTerminal({ name: 'Orka', pty, iconPath: new vscode.ThemeIcon('hubot') });
  }

  private write(text: string): void {
    if (this.opened) this.writeEmitter.fire(text);
    else this.buffer += text;
  }

  dispose(): void {
    this.closeListener.dispose();
    this.terminal?.dispose();
    this.writeEmitter.dispose();
  }
}
