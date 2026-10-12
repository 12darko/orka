import type { ApprovalRequest, ChangeTracker } from '@orka/core';
import * as path from 'node:path';
import * as vscode from 'vscode';

const ORIGINAL_SCHEME = 'orka-original';
const PROPOSED_SCHEME = 'orka-proposed';

/**
 * Serves "before" snapshots and proposed contents as virtual documents so AI changes can be
 * reviewed in VS Code's native diff editor - both after the fact and before approving an edit.
 */
export class DiffService implements vscode.Disposable {
  private readonly previews = new Map<string, NonNullable<ApprovalRequest['preview']>>();
  private readonly disposables: vscode.Disposable[] = [];
  private version = 0;

  constructor(private readonly getChanges: () => ChangeTracker) {
    const originals: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: (uri) => this.getChanges().getOriginal(fromQuery(uri, 'path')) ?? '',
    };
    const proposed: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: (uri) => {
        const preview = this.previews.get(fromQuery(uri, 'id'));
        if (!preview) return '';
        return (fromQuery(uri, 'side') === 'before' ? preview.before : preview.after) ?? '';
      },
    };
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originals),
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposed),
    );
  }

  setPreview(id: string, preview: ApprovalRequest['preview']): void {
    if (preview) this.previews.set(id, preview);
  }

  clearPreview(id: string): void {
    this.previews.delete(id);
  }

  hasPreview(id: string): boolean {
    return this.previews.has(id);
  }

  /** Diff of the file's original (pre-AI) content against its current content. */
  async openChangeDiff(absPath: string): Promise<void> {
    const name = path.basename(absPath);
    const left = this.uri(ORIGINAL_SCHEME, name, { path: absPath });
    const exists = await fileExists(absPath);
    const right = exists ? vscode.Uri.file(absPath) : this.uri(ORIGINAL_SCHEME, name, { path: '__deleted__' });
    const label = this.getChanges().getOriginal(absPath) === null ? 'new file' : exists ? 'AI changes' : 'deleted';
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${label})`, { preview: true });
  }

  /** Diff of a proposed change that is waiting for approval. */
  async openApprovalPreview(id: string): Promise<void> {
    const preview = this.previews.get(id);
    if (!preview) return;
    const name = path.basename(preview.path);
    const left = this.uri(PROPOSED_SCHEME, name, { id, side: 'before' });
    const right = this.uri(PROPOSED_SCHEME, name, { id, side: 'after' });
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (proposed change)`, { preview: true });
  }

  private uri(scheme: string, name: string, query: Record<string, string>): vscode.Uri {
    // A fresh version per open avoids VS Code serving a stale cached virtual document.
    const params = new URLSearchParams({ ...query, v: String(++this.version) });
    return vscode.Uri.from({ scheme, path: `/${name}`, query: params.toString() });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.previews.clear();
  }
}

function fromQuery(uri: vscode.Uri, key: string): string {
  return new URLSearchParams(uri.query).get(key) ?? '';
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
    return true;
  } catch {
    return false;
  }
}
