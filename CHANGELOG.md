# Changelog

## 0.1.0 (first public release)

- Main agent, Supervisor and explore / review / worker sub-agents, each on its own provider and model.
- Providers: Claude API, OpenAI, Gemini, and any OpenAI-compatible endpoint (OpenRouter, DeepSeek, xAI, Mistral, Groq, Together AI, Ollama, LM Studio, ...). The local Claude Code CLI is available as an opt-in, unofficial provider.
- Three apps on one core: VS Code extension, desktop app and `orka` CLI.
- Permission modes (Ask, Balanced, Autonomous) with per-category overrides; risky commands always ask.
- Change review: Changes panel, per-hunk revert, inline Keep / Revert in the editor, snapshots of files changed by terminal commands.
- Headless browser tool, background processes, web fetch.
- Skills (built-in and your own in `~/.orka/skills`) and MCP servers (stdio and Streamable HTTP).
- Task history, compaction with a handoff note, per-agent token usage and cost, token budget, fallback and light models.
- English and Turkish UI.
