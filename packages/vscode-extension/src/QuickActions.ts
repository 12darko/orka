import { t } from '@orka/core';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Hand a request to the agent (the chat view opens and the editor context rides along). */
type Ask = (text: string) => Promise<void>;

/** "Fix with Orka" on errors and warnings (the light bulb / Ctrl+.). */
class FixWithOrka implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    return context.diagnostics
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
      .slice(0, 3)
      .map((d) => {
        const action = new vscode.CodeAction(t('Fix with Orka: {message}', { message: firstLine(d.message, 60) }), vscode.CodeActionKind.QuickFix);
        action.command = {
          command: 'orka.fixProblem',
          title: action.title,
          arguments: [document.uri, d.range.start.line + 1, d.message, d.source ?? ''],
        };
        action.diagnostics = [d];
        return action;
      });
  }
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function relative(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder ? path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/') : path.basename(uri.fsPath);
}

function selectionInfo(): { file: string; start: number; end: number } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return undefined;
  return { file: relative(editor.document.uri), start: editor.selection.start.line + 1, end: editor.selection.end.line + 1 };
}

export function registerQuickActions(ask: Ask): vscode.Disposable[] {
  return [
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new FixWithOrka(), { providedCodeActionKinds: FixWithOrka.kinds }),
    vscode.commands.registerCommand('orka.fixProblem', async (uri: vscode.Uri, line: number, message: string, source: string) => {
      if (!(uri instanceof vscode.Uri)) return;
      await ask(
        t('Fix this problem in {file} at line {line}: {message}', {
          file: relative(uri),
          line,
          message: `${source ? `[${source}] ` : ''}${message}`,
        }),
      );
    }),
    vscode.commands.registerCommand('orka.explainSelection', async () => {
      const sel = selectionInfo();
      if (!sel) {
        void vscode.window.showInformationMessage(t('Select some code first.'));
        return;
      }
      await ask(t('Explain the selected code in {file} (lines {start}-{end}): what it does, how it fits into the project, and anything risky about it.', sel));
    }),
    vscode.commands.registerCommand('orka.askAboutSelection', async () => {
      const sel = selectionInfo();
      if (!sel) {
        void vscode.window.showInformationMessage(t('Select some code first.'));
        return;
      }
      const question = await vscode.window.showInputBox({
        title: t('Ask Orka about {file}, lines {start}-{end}', sel),
        placeHolder: t('e.g. Why is this slow? Refactor it to use async/await.'),
        ignoreFocusOut: true,
      });
      if (!question?.trim()) return;
      await ask(`${question.trim()}\n\n${t('(About the selected code in {file}, lines {start}-{end}.)', sel)}`);
    }),
  ];
}
