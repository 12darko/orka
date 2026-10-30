# Changelog

## 0.4.0

The desktop app gets Radar: it watches what other AI coding tools ship and, when you ask, proposes what Orka could add. See [Radar (desktop)](README.md#radar-desktop).

**Radar (desktop app)**

- **A tab next to the plan and changes** on the right of the window, also reachable from the session list and its rail. The classic single-column window has its switches in **Settings → Control → Radar**. The VS Code extension and the CLI have no Radar.
- **Off until you turn it on.** Before that, the tab lists every site it would contact (GitHub release feeds and the changelogs of Claude Code, Cursor, Kiro, VS Code, GitHub Copilot and ChatGPT Codex), and nothing is fetched.
- **While it is on**, it checks the public feeds 30 seconds after the start and then every hour (each feed at most every 6 to 24 hours, with conditional requests), never with a model call. The tab shows the count of new entries, when it last looked and which feeds failed. Turning it off stops the timer and any running check. The requests carry only Orka's name and version; nothing about you or your projects is sent, and there is no telemetry.
- **Analysis only on request:** **Analyze** runs on a provider and model you pick for Radar (or the main agent's, when that is a model API with a key), never on an agent CLI or Claude Code, on your own key and tokens: at most 40 entries and 100 model calls a run, with progress, the calls used and a **Stop** button. `radar.autoAnalyze` (off by default) analyzes right after a check found something.
- **The report** groups similar features across tools, shows Orka's status for each change (has it, has part of it, lacks it, not for Orka) and the decision with priority (P1–P3) and size (S/M/L), links the release notes (https pages only) and lets you retry entries the model could not read. Summaries, comparisons and proposals are written in the UI language (English or Turkish).
- **Start a session** on a proposal opens a new session in the current folder with the proposal in the message box, and sends nothing; the session never sees release-note text.
- **Files:** `~/.orka/radar/state.json` and `report.json` beside it (or under `ORKA_HOME`). A report that fails its checks is set aside and not used.
- **Settings** (desktop only, from your own settings file): `radar.enabled`, `radar.provider`, `radar.model`, `radar.autoAnalyze`.

**Core**

- The radar engine behind it (`packages/core/src/radar`): a checked source list, conditional polling with no model calls, a five-stage analysis in which every model answer has no tools and is checked against a strict JSON format, and validated reports.
- Its analysis takes a `language`: the text people read comes back in that language, while JSON keys, enum values and tags stay English and the check against copied release-note text still applies.

## 0.3.0

Coding agents you installed yourself can now be Orka's main agent, and the desktop session list gets your own groups.

**Agent CLIs (agent mode)**

- **Supported agents:** Gemini CLI, Codex (through the `codex-acp` adapter), GitHub Copilot CLI (preview), Cursor CLI, or any agent that speaks the Agent Client Protocol (ACP). Each one runs as the main agent: pick it in the agent menu after turning it on in **Settings → Providers → Agent CLIs**.
- **The agent runs its own loop. Orka keeps control of the rest:**
  - it answers the agent's permission requests with your permission mode;
  - the files the agent asks Orka for stay inside the project (what the agent does with its own tools follows its own sandbox and settings);
  - it lists the files the agent changes in the project in Changes, including files it writes with its own tools (a snapshot is taken around each request), so you can review and revert them. Files git ignores, such as `.env` or `node_modules`, are not snapshotted;
  - going back starts a fresh agent session, and the Supervisor reviews the result.
- **What it asks for:** a command request Orka cannot read, or one that runs outside the project, always asks and shows what the agent sent. A file the agent writes through Orka goes straight to disk (in VS Code an open editor reloads it); a link inside the project is written through to its target, a link out of it is refused.
- **Revert and Go back** put back the exact bytes a file had when the request began, and delete a file the agent created during the request with its own tools.
- **Supervisor:** next to an agent it needs a model provider of its own; without one it sits out, and Orka says so.
- **Signing in:** Orka never reads, stores or passes on an agent's sign-in. You sign in with the agent's own login command, which Orka opens in a terminal, with the agent's program by its full path and in your home folder. Orka runs only programs you installed and never downloads one.
- **Not offered:** Antigravity (Google's terms do not allow it through third-party software on consumer plans) and the Claude ACP adapter (licence unclear). Claude stays available through the Claude API and the opt-in Claude Code provider.
- **CLI:** `orka --provider agent:gemini` and `orka agents`. More in [docs/EXTERNAL_AGENTS.md](docs/EXTERNAL_AGENTS.md).

**Desktop app**

- **Your own session groups:** create, rename and remove them, and move a session in or out through its **…** menu. Folders and groups fold away, and sessions can be hidden from the list and shown again.

**Security (everywhere)**

- **Read-only commands are read word by word.** A command only counts as read-only (no approval in Ask mode) when Orka can read every part of it. Command substitution (`$(…)`, backticks), a single `&`, `env <program>`, options that start programs (`rg --pre`, `find -exec`, `tree -o`, `git --output`), wildcards or variables that could turn into options, and redirections into files now ask. Before, some of these ran without asking.
- **A repository's git config is read the way git reads it:** also a key on its section line, in nested repositories and submodules, and with signature programs, pagers and `core.hooksPath` counted as programs git would run. Git commands then ask, and Orka's own `git log` never verifies signatures.
- **Windows: no programs from the open folder.** Orka starts git, your shell and its other helpers by their full path from `PATH`, so a `git.exe` or `powershell.exe` a repository ships never runs. In the desktop app and the CLI, nothing Orka starts (commands, background processes, MCP servers, agents, terminal windows) picks a program from its current folder by its bare name: in cmd.exe and npm scripts, use `.\name` or a full path (`.\gradlew`). An MCP server whose `command` sits in its configured `cwd` still starts.
- Task history saves run one after another, so a request that ends while you start a new task is kept in its own task.

**Other**

- The repository moved to [Enophia-Studio/orka](https://github.com/Enophia-Studio/orka). Links and the update check follow; the old address still redirects.

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
