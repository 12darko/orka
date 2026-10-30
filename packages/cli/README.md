# Orka CLI

Orka in the terminal: an AI coding orchestrator with a main agent, a Supervisor that reviews its work, sub-agents, Skills, MCP servers, permissions, `/diff` and `/undo`, and task history. It is the same core as the [Orka VS Code extension and desktop app](https://github.com/Enophia-Studio/orka).

## Install

Node.js 22 or newer. The CLI is not on the npm registry yet; install the `orka` command from the [GitHub release](https://github.com/Enophia-Studio/orka/releases/latest):

```bash
npm install -g https://github.com/Enophia-Studio/orka/releases/download/v0.4.0/orka-agent-0.4.0.tgz
```

Or build it from source: clone the repository, run `npm install` and `npm run build`, then `node packages/cli/dist/orka.js` (or `npm link` in `packages/cli`).

## Usage

```text
orka                       Start a session in this folder
orka "fix the login bug"   Start with a request
orka -p "explain main.ts"  Answer one request and exit (reply on stdout, progress on stderr)
orka -c                    Continue the last task in this folder
orka models [provider]     List the models Orka knows
orka agents [id]           List the agent CLIs Orka can run as the main agent, and their status
orka config                Show where the config lives and what is in use
```

| Option | |
|---|---|
| `--provider <id>` | `claude`, `openai`, `gemini`, `claude-code` (opt-in), a custom id from the config, or `agent:<id>` for an agent CLI (see [below](#agent-clis-agent-mode)) |
| `-m, --model <id>` | Model for the main agent |
| `--mode <m>` | `ask`, `balanced` (default) or `autonomous` |
| `-y, --yes` | Same as `--mode autonomous` (dangerous commands still ask) |
| `--supervisor <p[:m]>` | Supervisor provider and model, e.g. `claude:claude-sonnet-5-5` |
| `--no-supervisor` | No Supervisor for this session |
| `-C, --cwd <dir>` | Work in this folder instead of the current one |
| `--lang <en\|tr>` | Language (default: the system language) |
| `-h, --help`, `-v, --version` | |

In a session, `/help` lists the commands: `/new`, `/diff`, `/undo`, `/rewind [n]`, `/compact`, `/mode`, `/model`, `/usage`, `/skills`, `/<skill> <request>`, `/freebuff`, `/exit`. `@path` attaches a file or image; Ctrl+C stops the running request.

Approvals are asked in the terminal. Without a terminal (piped input), anything that needs approval is declined, never approved silently.

## Agent CLIs (agent mode)

A coding agent CLI you installed and signed in to yourself can be the main agent: Orka runs it over the Agent Client Protocol (ACP) and keeps its permissions, `/diff`, `/undo`, `/rewind` and the Supervisor's final review around it. The details, the terms each agent runs under and what Orka never does with an agent's sign-in are in [docs/EXTERNAL_AGENTS.md](https://github.com/Enophia-Studio/orka/blob/main/docs/EXTERNAL_AGENTS.md).

```bash
orka agents                              # the agents, whether they are installed, their terms and install commands
orka --provider agent:gemini             # Gemini CLI as the main agent (also agent:codex, agent:copilot, agent:cursor)
orka --provider agent:custom:my-agent    # an ACP agent you added in the config
```

```json
{
  "provider": "agent:gemini",
  "supervisor": { "provider": "claude", "model": "claude-sonnet-5-5" },
  "agentClis": {
    "enabled": ["gemini", "custom:my-agent"],
    "paths": { "gemini": "/opt/tools/gemini" },
    "custom": [{ "name": "My agent", "command": "my-agent", "args": ["--acp"] }]
  }
}
```

- `--provider agent:<id>` runs any agent `orka agents` lists. The config's `"provider"` may only name an agent in `"agentClis.enabled"`. In a session, `/model agent:<id>` switches to an agent and `/model <provider>:<model>` back to a model.
- `"paths"`: an agent's executable when it is not on `PATH`. `"custom"`: ACP agents you add yourself, on your own responsibility; the id is `custom:` and the name in lowercase with dashes, cut to 40 characters.
- Orka checks before the session starts: an unknown agent, an agent that is not installed (Orka shows the vendor's install command and never runs it), a model given for an agent (it uses the model from its own settings), and missing snapshots (`"trackCommandChanges": false`, or no git) all stop with an error. Snapshots are how files the agent changes with its own tools show up in `/diff` and can be reverted with `/undo`; files git ignores (such as `.env`) and anything outside the folder are not snapshotted.
- Only the main agent can be an agent CLI. The Supervisor needs its own model provider: `--supervisor <provider[:model]>` or `"supervisor": { "provider": ... }`; without one the session runs without a Supervisor and says so.
- Sign in with the vendor's own login command (`orka agents` names it). If the agent is not signed in, the first request fails with that command.
- **Approvals with `-p`:** without a terminal to ask (scripts, CI, piped input), every approval that would ask is declined, never approved silently. That includes the agent's own permission requests and the file writes and commands it asks Orka for; the agent is told and continues without them. The permission mode (`--mode`) decides what the agent may do unattended; risky commands, commands Orka cannot read and requests to switch the agent's mode always ask, so they are declined. (Run from an interactive terminal, `-p` asks there.)
- Agent processes keep running between requests and stop when `orka` exits. `/usage` and the summary line show an agent's token use as *not reported*: agents do not report it.

## API keys

API keys are read from environment variables only and are never written to the config:

- `ANTHROPIC_API_KEY` (Claude), `OPENAI_API_KEY` (OpenAI), `GEMINI_API_KEY` or `GOOGLE_API_KEY` (Gemini)
- custom OpenAI-compatible endpoints (OpenRouter, Ollama, LM Studio, ...): the variable named by `apiKeyEnv` in the config

The local Claude Code CLI can be used as a provider without a key (unofficial, off by default): set `"claudeCode": { "enabled": true }` in the config.

## Configuration

Settings live in `~/.orka/config.json` (or `$ORKA_HOME/config.json`); `orka config` prints an example. Task history and snapshots are shared with the Orka desktop app.

## Update check

Once a day, an interactive session asks GitHub in the background whether a newer Orka release is out (one request to `api.github.com`, nothing else is sent) and mentions it at the next start, under the banner: `Orka 0.2.0 is available: https://github.com/Enophia-Studio/orka/releases/tag/v0.2.0`. It never downloads or installs anything, never delays startup, and does not run with `-p` or when the output is not a terminal. The last answer is kept in `~/.orka/update-check.json`.

Turn it off with `"updateCheck": false` in the config, or `ORKA_NO_UPDATE_CHECK=1` in the environment.

## Links

- Source, issues and the other Orka apps: https://github.com/Enophia-Studio/orka
- License: MIT. The bundled open-source packages and their licenses are listed in `dist/THIRD_PARTY_NOTICES.txt`.
