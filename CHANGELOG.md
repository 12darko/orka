# Changelog

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
