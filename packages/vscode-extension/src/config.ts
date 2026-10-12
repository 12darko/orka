import { MACHINE_SETTINGS, type SettingsStore, USER_LEVEL_SETTINGS } from '@orka/app';
import * as vscode from 'vscode';

export const SECTION = 'orka';

/** Orka's settings in VS Code's configuration ("orka.*"). */
export class VSCodeSettings implements SettingsStore {
  get<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
  }

  isSet(key: string): boolean {
    const i = vscode.workspace.getConfiguration(SECTION).inspect(key);
    return i?.globalValue !== undefined || i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined;
  }

  scopeOf(key: string): 'user' | 'workspace' | undefined {
    const i = vscode.workspace.getConfiguration(SECTION).inspect(key);
    if (i?.workspaceFolderValue !== undefined || i?.workspaceValue !== undefined) return 'workspace';
    return i?.globalValue !== undefined ? 'user' : undefined;
  }

  /**
   * Write a setting where the user already keeps it; otherwise in the workspace (or, for settings
   * that describe the user rather than the project, such as custom providers, globally).
   */
  async update(key: string, value: unknown, options: { preferGlobal?: boolean } = {}): Promise<void> {
    const fallback =
      options.preferGlobal || USER_LEVEL_SETTINGS.has(key) || !vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Global
        : vscode.ConfigurationTarget.Workspace;
    const c = vscode.workspace.getConfiguration(SECTION);
    // Machine-scoped settings only exist in the user's settings.
    if (MACHINE_SETTINGS.has(key)) return c.update(key, value, vscode.ConfigurationTarget.Global);
    const inspected = c.inspect(key);
    const where =
      inspected?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspected?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : inspected?.globalValue !== undefined
            ? vscode.ConfigurationTarget.Global
            : fallback;
    await c.update(key, value, where);
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) listener();
    });
  }
}
