import { type ChangeTracker, type DiffHunk, t } from '@orka/core';
import * as vscode from 'vscode';

/**
 * Review AI changes where they are: in the editor, lines the agent added are highlighted, removed
 * lines are marked, and each change hunk gets "Keep / Revert / Diff" code lenses.
 */
export class InlineReview implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removed = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em', fontStyle: 'italic' },
  });
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private tracker?: ChangeTracker;

  constructor(
    private readonly getTracker: () => ChangeTracker | undefined,
    private readonly enabled: () => boolean,
  ) {
    this.disposables.push(
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument(() => this.schedule()),
    );
  }

  /** Call when the tracker may have changed (new orchestrator) or settings changed. */
  attach(): void {
    const tracker = this.getTracker();
    if (tracker !== this.tracker) {
      this.unsubscribe?.();
      this.tracker = tracker;
      this.unsubscribe = tracker?.onDidChange(() => this.schedule());
    }
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 250);
  }

  private async hunksFor(uri: vscode.Uri): Promise<DiffHunk[]> {
    const tracker = this.tracker;
    if (!tracker || !this.enabled() || uri.scheme !== 'file' || !tracker.isTracked(uri.fsPath)) return [];
    if (tracker.getOriginal(uri.fsPath) === null) return []; // a new file is all new; review it in the diff
    return tracker.hunks(uri.fsPath).catch(() => []);
  }

  private async refresh(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      const hunks = await this.hunksFor(editor.document.uri);
      const added: vscode.Range[] = [];
      const removed: vscode.DecorationOptions[] = [];
      for (const hunk of hunks) {
        let line = hunk.newStart;
        let gone = 0;
        const flush = () => {
          if (!gone) return;
          const at = Math.max(0, Math.min(line, editor.document.lineCount) - 1);
          removed.push({
            range: new vscode.Range(at, Number.MAX_SAFE_INTEGER, at, Number.MAX_SAFE_INTEGER),
            renderOptions: { after: { contentText: t('− {n} line(s) removed', { n: gone }) } },
          });
          gone = 0;
        };
        for (const l of hunk.lines) {
          if (l.type === '-') {
            gone++;
            continue;
          }
          flush();
          if (l.type === '+') added.push(new vscode.Range(line, 0, line, 0));
          line++;
        }
        flush();
      }
      editor.setDecorations(this.added, added);
      editor.setDecorations(this.removed, removed);
    }
    this.changed.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const hunks = await this.hunksFor(document.uri);
    const lenses: vscode.CodeLens[] = [];
    hunks.forEach((hunk, index) => {
      // Put the lenses on the first changed line, not on the leading context.
      const lead = hunk.lines.findIndex((l) => l.type !== ' ');
      const line = Math.min(document.lineCount - 1, hunk.newStart + Math.max(0, lead));
      const range = new vscode.Range(line, 0, line, 0);
      const args = [document.uri, index];
      lenses.push(
        new vscode.CodeLens(range, { title: `$(check) ${t('Keep')}`, command: 'orka.keepHunk', arguments: args, tooltip: t('Keep this change') }),
        new vscode.CodeLens(range, { title: `$(discard) ${t('Revert')}`, command: 'orka.revertHunkInline', arguments: args, tooltip: t('Undo only this part of the change') }),
        new vscode.CodeLens(range, { title: t('Orka change {i} of {n}', { i: index + 1, n: hunks.length }), command: 'orka.openChangeDiff', arguments: [document.uri] }),
      );
    });
    return lenses;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.added.dispose();
    this.removed.dispose();
    this.changed.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
