# Orka CLI

Orka in the terminal: an AI coding orchestrator with a main agent, a Supervisor that reviews its work, sub-agents, Skills, MCP servers, permissions, `/diff` and `/undo`, and task history. It is the same core as the [Orka VS Code extension and desktop app](https://github.com/Enophia-Studio/orka).

## Install

Node.js 22 or newer. The CLI is not on the npm registry yet; install the `orka` command from the [GitHub release](https://github.com/Enophia-Studio/orka/releases/latest):

```bash
npm install -g https://github.com/Enophia-Studio/orka/releases/download/v0.2.0/orka-agent-0.2.0.tgz
```

Or build it from source: clone the repository, run `npm install` and `npm run build`, then `node packages/cli/dist/orka.js` (or `npm link` in `packages/cli`).

## Usage

```text
orka                       Start a session in this folder
orka "fix the login bug"   Start with a request
orka -p "explain main.ts"  Answer one request and exit (reply on stdout, progress on stderr)
orka -c                    Continue the last task in this folder
orka models [provider]     List the models Orka knows
orka config                Show where the config lives and what is in use
```

| Option | |
|---|---|
| `--provider <id>` | `claude`, `openai`, `gemini`, `claude-code` (opt-in), or a custom id from the config |
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
