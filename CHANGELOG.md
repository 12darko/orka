# Changelog

## 0.2.0

The desktop app gets a calm, roomy window of its own: your sessions on the left, the conversation in the middle, the plan and the changes on the right.

**Desktop app**

- New layout:
  - **Sessions on the left:** the tasks of your recent project folders, with a search box, a new session per folder, and delete. Opening a session from another folder switches to it.
  - **The conversation in the middle:** a centered column. Tool calls are quiet one-line entries that open on a click.
  - **A message box that holds its controls:** **+** (attach a file, add an image, use a skill or command), the permission mode, the model and a round send button. A new session starts with the box in the middle of the window and suggestions under it.
  - **The task's plan and changes on the right**, in their own panel.
  - **Shortcuts:** Ctrl+B and Ctrl+Alt+B show and hide the two sides (a closed session list becomes a narrow rail of icons); Ctrl+K searches the sessions; Ctrl+Alt+N starts a new session.
  - A finished reply can be copied, and a button takes you back to the newest message when you scroll up.
  - **The single-column window is still there:** **Settings → Control → Appearance → Layout**.
- **Orka's own light and dark theme**, taken from its logo. It follows the system, or you pick one at the bottom of the session list or in the settings (setting `desktop.theme`).
- **`orka-desktop.exe` starts without a console window.** When it cannot start, a message box says why, and `~/.orka/desktop/desktop.log` keeps the details.
- Edge no longer offers to translate the window.
- **Fixed:** the desktop app could quit right at start when Windows briefly held its state file open (a virus scanner or the search indexer). Saving now tries again for a moment, and remembered state that cannot be saved no longer stops the app.
- **Security:** `desktop.log` is private to your user on macOS and Linux and masks anything shaped like an API key. A failed keychain call no longer reports its command line, which on macOS held the key being saved.

**Everywhere**

- **Update notices:** once a day Orka checks whether a newer release is out and says so, with a link to its page. Nothing is downloaded or installed.
  - Turn it off with `orka.updates.check` (VS Code) or `updates.check` (desktop), `"updateCheck": false` in the CLI config, or `ORKA_NO_UPDATE_CHECK=1`.
  - **Settings → Control** shows Orka's version and checks on request.
- **Fixed:** the usage bars and the plan's progress bar stayed empty, because the UI's content security policy blocks inline styles.

**For contributors**

- The chat UI's text sizes and radii are tokens (`packages/app/webview/styles/tokens.css`). The desktop's IDE layout (`webview/ide.css`) raises the base size and the radii.
- Shared parts of the UI moved out of `webview/main.ts`: the bridge, HTML helpers and formatting into `webview/core/`, and the in-app dialogs into `webview/features/dialogs.ts`. The IDE layout lives in `webview/ide/`.
- `@orka/app` has tests now (`npm test -w @orka/app`), with a fake shell for the controller. The desktop end-to-end tests cover the session list, the theme and the layout switch.
- The desktop theme moved to `packages/app/webview/desktop-theme.css`, so the UI preview shows the desktop window too (`npm run preview -w @orka/app`, then add `?ide`).

## 0.1.1

Security fixes found by code scanning after 0.1.0. Please update.

**Security**

- Pages and command output the agent reads can no longer stall Orka: turning HTML into text, removing terminal color codes and parsing Supervisor replies, lessons and inline scripts now take linear time. Before, a crafted 50 KB page took 1.3 s, and the time grew with the square of its size. The page text is the same as in 0.1.0, also for Turkish pages and pages without a closing `</head>`; only an unclosed `<script>` or `<style>` now hides the rest of the page, as in a browser.
- Windows: MCP servers started through a batch file (`npx.cmd` and the like) get their arguments quoted and escaped, so no argument can start another command. Servers found on the PATH as programs start directly.
- The chat UI escapes every value it gets from the app before showing it (statuses, numbers and token counts too) and only accepts messages from the app itself.
- The Claude Code provider's working folder is created with `mkdtemp`: it is private to your user (on macOS and Linux) and no longer sits in a shared `orka-claude-code` folder in the temp directory.
- Smaller fixes: `data:` and `vbscript:` links in fetched pages are no longer shown to the agent as links, the binary content-type check is anchored to the start of the header, selectors reach the headless browser URI-encoded, and three check-then-use file accesses became single steps.

**Requirements**

- Node.js 22 or newer (the provider SDKs and the browser tool need it) and VS Code 1.101 or newer for the extension.

**Distribution**

- The CLI is attached to the release as `orka-agent-<version>.tgz`: `npm install -g` it from the release URL.
- `orka-desktop.exe` shows up as *Orka Desktop* by Enophia Software, with Orka's icon, instead of as Node.js.
- The extension, the CLI package and the desktop app ship a `THIRD_PARTY_NOTICES.txt` with the licenses of the open-source software they include, and the release notes say how to install each app.
- Updated provider SDKs (Anthropic, OpenAI, Google Gen AI), `marked` 18 and the GitHub Actions used by CI and releases.

## 0.1.0 (first public release)

- Main agent, Supervisor and explore / review / worker sub-agents, each on its own provider and model.
- Providers: Claude API, OpenAI, Gemini, and any OpenAI-compatible endpoint (OpenRouter, DeepSeek, xAI, Mistral, Groq, Together AI, Ollama, LM Studio, ...). The local Claude Code CLI is available as an opt-in, unofficial provider.
- Three apps on one core: VS Code extension, desktop app (also as a single Windows executable, `orka-desktop.exe`) and the `orka` CLI.
- Hooks: your formatter or linter after each edit (`afterEdit`) and your checks before the agent finishes (`beforeFinish`), with failures sent back to the agent.
- Learning from tasks: lasting project lessons in `.project-ai/lessons.md`.
- Go back (rewind) to before any message of a task: the conversation and the files the agents changed since.
- Workers called together run side by side in their own copies of the project; their changes are merged three-way afterwards and overlapping edits are reported.
- Permission modes (Ask, Balanced, Autonomous) with per-category overrides; risky commands, downloads, inline scripts with file/network access and writes outside the workspace always ask.
- Change review: Changes panel, per-hunk revert, inline Keep / Revert in the editor, snapshots of files changed by terminal commands.
- Headless browser tool, background processes, web fetch.
- Skills (built-in and your own in `~/.orka/skills`) and MCP servers (stdio and Streamable HTTP).
- Task history, compaction with a handoff note, per-agent token usage and cost, token budget, fallback and light models.
- English and Turkish UI.
- Security hardening before release: settings that start programs, send API keys or loosen permissions can't come from a repository's own settings; workspace hooks and `.mcp.json` servers need your OK; no cloud-metadata or link-local fetches; git never runs programs named by a repository's own config without asking; `open_browser` never opens scripts or executables; the desktop start link works once.
