// The connection to the app: VS Code's webview API, or the desktop app's stand-in for it.
import type { FromWebview } from '../../src/protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

// VS Code allows one call per page.
const vscode = acquireVsCodeApi();

export const post = (message: FromWebview) => vscode.postMessage(message);

/** What the UI keeps across reloads: the unsent draft and, in the desktop app, which side panels are closed. */
export interface UiState {
  draft?: string;
  sidebarClosed?: boolean;
  asideClosed?: boolean;
}

const initial = vscode.getState();
let state: UiState = initial && typeof initial === 'object' ? { ...(initial as UiState) } : {};

export function uiState(): Readonly<UiState> {
  return state;
}

/** Saves the whole state (VS Code replaces it on every call), with these fields changed. */
export function saveUiState(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  vscode.setState(state);
}
