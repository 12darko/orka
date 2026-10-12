import { AppController } from '@orka/app';
import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
import { registerQuickActions } from './QuickActions';
import { VSCodeShell } from './VSCodeShell';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const shell = new VSCodeShell(context);
  const controller = new AppController(shell);
  context.subscriptions.push(
    { dispose: () => void controller.dispose() },
    shell,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, shell.view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('orka.ask', (text?: string) => controller.ask(typeof text === 'string' ? text : undefined)),
    vscode.commands.registerCommand('orka.newTask', () => controller.newTask()),
    vscode.commands.registerCommand('orka.stop', () => controller.stop()),
    vscode.commands.registerCommand('orka.setApiKey', () => controller.promptApiKey()),
    vscode.commands.registerCommand('orka.clearApiKey', () => controller.clearApiKey()),
    vscode.commands.registerCommand('orka.selectProvider', () => controller.selectProvider()),
    vscode.commands.registerCommand('orka.configureAgents', () => controller.showAgents()),
    vscode.commands.registerCommand('orka.openSettingsView', () => controller.showSettings()),
    vscode.commands.registerCommand('orka.showHistory', () => controller.showHistory()),
    vscode.commands.registerCommand('orka.compact', () => controller.compact()),
    vscode.commands.registerCommand('orka.addProvider', () => controller.addProvider()),
    vscode.commands.registerCommand('orka.selectMode', () => controller.selectMode()),
    vscode.commands.registerCommand('orka.acceptAllChanges', () => controller.acceptAll()),
    vscode.commands.registerCommand('orka.revertAllChanges', () => controller.revertAll()),
    vscode.commands.registerCommand('orka.initProjectMemory', () => controller.initMemory()),
    vscode.commands.registerCommand('orka.showSkills', () => controller.showSettings('skills')),
    vscode.commands.registerCommand('orka.newSkill', () => controller.newSkill()),
    vscode.commands.registerCommand('orka.openSkillsFolder', () => controller.openSkillsFolder()),
    vscode.commands.registerCommand('orka.selectWorkspaceFolder', () => controller.pickWorkspaceFolder()),
    vscode.commands.registerCommand('orka.checkForUpdates', () => controller.checkForUpdates()),
    vscode.commands.registerCommand('orka.handoffFreebuff', () => controller.handOff('freebuff')),
    vscode.commands.registerCommand('orka.importMcpFromClaude', () => controller.importMcpFromClaude()),
    vscode.commands.registerCommand('orka.showMcp', () => controller.showSettings('mcp')),
    ...registerQuickActions((text) => controller.ask(text)),
    vscode.commands.registerCommand('orka.keepHunk', (uri: vscode.Uri, index: number) => controller.keepHunk(uri.fsPath, index)),
    vscode.commands.registerCommand('orka.revertHunkInline', (uri: vscode.Uri, index: number) => controller.revertHunk(uri.fsPath, index)),
    vscode.commands.registerCommand('orka.openChangeDiff', (uri: vscode.Uri) => controller.openChangeDiff(uri.fsPath)),
  );
  await controller.initialize();
}

export function deactivate(): void {}
