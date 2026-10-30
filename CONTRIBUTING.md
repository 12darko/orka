# Contributing to Orka

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Getting started

You need Node.js 22 or newer, git, and VS Code 1.101 or newer (for the extension). Chrome or Edge is needed for the browser tool and the desktop app tests.

```bash
git clone https://github.com/Enophia-Studio/orka.git
cd orka
npm install
npm run build
npm test
```

- **VS Code extension:** open the folder in VS Code and press **F5** (*Run Extension*).
- **Desktop app:** `npm run desktop`; `npm run desktop:exe` builds it as a single executable that needs no Node (`packages/desktop/dist/orka-desktop.exe`)
- **CLI:** `node packages/cli/dist/orka.js`
- **Chat UI in a browser** with a sample session: `npm run preview -w @orka/app`, then open <http://localhost:5178> (`?light`, `?empty`, `?tr`, `?nocc`, `?settings=providers`; `?ide` shows the desktop app's window with its session list and theme, and `?ide&radar=off`, `pending` or `report` opens its Radar tab with sample data).

## Project layout

| Package | What lives there |
|---|---|
| `packages/core` (`@orka/core`) | Everything editor-agnostic: agent loop, supervisor, sub-agents, providers, tools, permissions, context, MCP, skills, i18n |
| `packages/app` (`@orka/app`) | The chat UI (webview) and the `AppController` shared by the VS Code extension and the desktop app. In `webview/`: `core/` (bridge, HTML helpers), `features/`, `ide/` (the desktop app's session list and layout), `styles/tokens.css` (sizes), `ide.css` and `desktop-theme.css` (desktop only) |
| `packages/vscode-extension` | The VS Code shell: settings, secret storage, diffs, inline review |
| `packages/desktop` | The desktop shell: local server, OS key store, native dialogs |
| `packages/cli` | The `orka` terminal app |

## Before you open a pull request

1. `npm run typecheck` and `npm test` pass.
2. New behaviour has a test. Core logic is tested in `packages/core/test`, the controller and the UI's helpers in `packages/app/test` (with a fake shell), the CLI and desktop app end to end in their own `test` folders.
3. Every user-facing string goes through `t()` and has a Turkish entry in `packages/core/src/i18n/tr.ts`; a test checks this. Technical terms (Agent, Supervisor, Provider, Skills, Token, MCP) stay in English in the Turkish UI.
4. Anything Orka does that edits files or runs commands goes through the permission system; never add a path that skips approval. In agent mode the vendor's agent acts on its own: where it asks (its permission requests, and the file writes and terminal commands it asks Orka to do), the answer comes from Orka's permission rules and prompts; what it does with its own tools without asking is observed and revertible through the workspace snapshots, for the files git would track (ignored files and anything outside the workspace are not covered, and docs must not claim they are). Its actions are never silently trusted.
5. Keep the conversation append-only (system prompt and tool list stay fixed during a task) so prompt caching keeps working.

Small, focused pull requests are easier to review. For a larger change, open an issue first so we can agree on the approach.

## Releasing (maintainers)

1. Set the new version everywhere at once: `npm version <version> --no-git-tag-version --workspaces --include-workspace-root`, then `VERSION` in `packages/core/src/version.ts`, the file names in `README.md` and `packages/cli/README.md`, and a `## <version>` section in `CHANGELOG.md`. `npm run check:version` lists anything that still differs (CI runs it too).
2. Commit and push to `main`, and wait for CI to pass (it runs the version check and builds what a release ships).
3. Optional dry run: start the *Release* workflow by hand on `main` (**Actions → Release → Run workflow**). It builds and tests the pushed commit and keeps the files as a workflow artifact; a run started by hand never publishes.
4. Tag that commit and push the tag: `git tag v<version>` and `git push origin v<version>`.
5. The *Release* workflow builds, tests and packages the extension, builds the desktop app as one Windows executable (`npm run desktop:exe`) and the CLI as an npm package file, and publishes a GitHub release with the `.vsix`, `orka-desktop.exe`, `orka-agent-<version>.tgz`, the desktop app's third-party notices, the changelog section and install notes. When the repository has an `NPM_TOKEN` secret, it also publishes the CLI to npm (`npm publish -w orka-agent`). Don't upload files built on your own machine instead: release files come from a clean `npm ci` on CI, and only CI adds npm provenance.

## Reporting bugs

Use the bug report template and include your OS, the app (VS Code / desktop / CLI), the provider and model, and what you expected to happen. For security problems, see [SECURITY.md](SECURITY.md).

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
