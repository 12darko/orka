# Orka - AI Coding Orchestrator (VS Code)

An AI coding agent for VS Code that works with the model of your choice: Claude API, OpenAI, Gemini or any OpenAI-compatible provider (OpenRouter, DeepSeek, Ollama, LM Studio, ...). It studies your project, proposes a plan, edits files, runs builds and tests, looks at the result in a browser, reviews it and fixes what's broken, while you keep control of every risky step.

- **Agents:** a main agent, a supervisor that checks it at key moments and corrects it, and explore / review / worker sub-agents. Each one can run on its own provider and exact model version (e.g. Opus 5.5, GPT-6 Sol, Gemini 3.8 Flash). Simple questions can go to a lighter model, and a fallback model takes over when a provider hits its limit.
- **Sees the browser:** the agent opens pages in a headless Chrome or Edge, sees screenshots, clicks, types and reads console errors, so it can check the UI it just built.
- **Skills and MCP:** built-in expert playbooks (Unity, debugging, testing, code review, security, ...) plus your own in `~/.orka/skills`, and tools from MCP servers (Unity, Blender, databases, ...).
- **Permission modes:** *Ask*, *Balanced* and *Autonomous*, with per-category overrides for file edits, terminal, git, web and deletes. Risky commands and writes outside the workspace always ask.
- **Review every change:** changed lines are highlighted in the editor with Keep / Revert above each change; the Changes panel diffs, keeps or reverts per file, per hunk or all at once. Files changed by terminal commands are included.
- **Hooks:** your formatter or linter runs after each edit and your checks before the agent finishes (`orka.hooks`); failures go back to the agent.
- **Learns your project:** lasting lessons from each task are kept in `.project-ai/lessons.md` for the next one.
- **Go back and parallel workers:** rewind to before any message (conversation and files), and let several workers edit side by side in copies of the project.
- **Hand off to Freebuff:** continue a task in the free Freebuff terminal agent; Orka copies a task summary and afterwards shows what Freebuff changed, ready to keep or revert.
- **History, compaction and usage:** earlier tasks can be continued; long tasks are compacted with a handoff note; token use and cost are shown per agent, with an optional token budget per request.
- **Languages:** English and Turkish; the UI follows the machine's language.

## Getting started

1. Open a folder.
2. Click the orca in the activity bar to open **Orka**.
3. Run **Orka: Set API Key** for your provider. Keys are stored in VS Code's secret storage; `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `GEMINI_API_KEY` also work.
4. Describe a task.

Settings live under `orka.*` and in the view's own settings screen. The same engine is available in the terminal as the `orka` CLI and as a desktop app.

### Claude Code (optional, unofficial)

If you have the Claude Code CLI installed and logged in, you can turn on `orka.claudeCode.enabled` (Settings → Providers) to use it as a provider without an API key. Orka is not affiliated with Anthropic; this runs your own Claude Code login, so make sure your use follows Anthropic's terms. For teams and products, use a Claude API key.

Source, documentation and issues: <https://github.com/12darko/orka>. Made by Enophia Software, open source under the MIT License.
