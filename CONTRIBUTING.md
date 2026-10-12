# Contributing to Orka

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Getting started

You need Node.js 20 or newer, git, and VS Code (for the extension). Chrome or Edge is needed for the browser tool and the desktop app tests.

```bash
git clone https://github.com/12darko/orka.git
cd orka
npm install
npm run build
npm test
```

- **VS Code extension:** open the folder in VS Code and press **F5** (*Run Extension*).
- **Desktop app:** `npm run desktop`; `npm run desktop:exe` builds it as a single executable that needs no Node (`packages/desktop/dist/orka-desktop.exe`)
- **CLI:** `node packages/cli/dist/orka.js`
- **Chat UI in a browser** with a sample session: `npm run preview -w @orka/app`, then open <http://localhost:5178> (`?light`, `?empty`, `?tr`, `?nocc`, `?settings=providers`).

## Project layout

| Package | What lives there |
|---|---|
| `packages/core` (`@orka/core`) | Everything editor-agnostic: agent loop, supervisor, sub-agents, providers, tools, permissions, context, MCP, skills, i18n |
| `packages/app` (`@orka/app`) | The chat UI (webview) and the `AppController` shared by the VS Code extension and the desktop app |
| `packages/vscode-extension` | The VS Code shell: settings, secret storage, diffs, inline review |
| `packages/desktop` | The desktop shell: local server, OS key store, native dialogs |
| `packages/cli` | The `orka` terminal app |

## Before you open a pull request

1. `npm run typecheck` and `npm test` pass.
2. New behaviour has a test. Core logic is tested in `packages/core/test`, the CLI and desktop app end to end in their own `test` folders.
3. Every user-facing string goes through `t()` and has a Turkish entry in `packages/core/src/i18n/tr.ts`; a test checks this. Technical terms (Agent, Supervisor, Provider, Skills, Token, MCP) stay in English in the Turkish UI.
4. Anything that can change files or run commands goes through the permission system. Never add a path that skips approval.
5. Keep the conversation append-only (system prompt and tool list stay fixed during a task) so prompt caching keeps working.

Small, focused pull requests are easier to review. For a larger change, open an issue first so we can agree on the approach.

## Releasing (maintainers)

1. Bump `version` in `packages/vscode-extension/package.json` (and in `packages/cli/package.json` and `packages/desktop/package.json`) and add a `## <version>` section to `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v<version>` and `git push origin v<version>`.
3. The *Release* workflow builds, tests and packages the extension, builds the desktop app as one Windows executable (`npm run desktop:exe`), and publishes a GitHub release with the `.vsix`, `orka-desktop.exe` and the changelog section. When the repository has an `NPM_TOKEN` secret, it also publishes the CLI to npm (`npm publish -w orka-agent`).

## Reporting bugs

Use the bug report template and include your OS, the app (VS Code / desktop / CLI), the provider and model, and what you expected to happen. For security problems, see [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
