# Agent CLIs (agent mode)

In agent mode, a coding agent you installed yourself, such as Gemini CLI, Codex, GitHub Copilot CLI or Cursor CLI, is Orka's **main agent**. Orka talks to it over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), the protocol these agents document for editors and other clients: Orka starts the program in your project folder in its ACP mode, sends it your requests, and answers what the agent asks for (permission for its tool calls, reading and writing files, running terminal commands).

The agent runs its own loop, with its own model and **its own sign-in**. Orka keeps its safety net around it: permissions, the Changes list with revert, Go back, hooks and the Supervisor's review of the result.

- [Turning it on](#turning-it-on)
- [Supported agents](#supported-agents)
- [What Orka keeps doing](#what-orka-keeps-doing)
- [What agent mode leaves out](#what-agent-mode-leaves-out)
- [Compliance rules](#compliance-rules)
- [Agents that are not in the catalog](#agents-that-are-not-in-the-catalog)
- [Adding your own ACP agent](#adding-your-own-acp-agent)
- [A note on Gemini CLI](#a-note-on-gemini-cli)
- [Troubleshooting](#troubleshooting)

## Turning it on

1. Install the agent and sign in with its own login command (see the table below). Orka never installs an agent and never signs in for you.
2. Turn the agent on and make it the main agent:

| App | Settings |
|---|---|
| VS Code | `orka.agentClis.enabled` lists the agents you turned on; `orka.provider` set to `agent:<id>` makes one the main agent |
| Desktop | The same keys without the `orka.` prefix (`agentClis.enabled`, `provider`) |
| CLI | `orka --provider agent:<id>`, or `"provider": "agent:<id>"` with `"agentClis": { "enabled": ["<id>"] }` in `~/.orka/config.json`; `orka agents` lists the agents and whether they are installed. See the [CLI README](../packages/cli/README.md#agent-clis-agent-mode). |

`<id>` is `gemini`, `codex`, `copilot`, `cursor`, or `custom:<name>` for an agent you added. Only the main agent can be an agent CLI: the Supervisor, the light model, the fallback and the sub-agents always run on a model provider.

Two more settings only come from your own settings on that machine (VS Code's *machine* scope: a repository's `.vscode/settings.json` cannot set them):

- `agentClis.paths`: the executable per agent id, when it is not on `PATH`, e.g. `{ "gemini": "C:\\tools\\gemini.cmd" }`.
- `agentClis.custom`: ACP agents you add yourself (see [below](#adding-your-own-acp-agent)).

`agentClis.enabled` is a user setting too (VS Code's *application* scope), so a repository cannot turn an agent on. On the command line, `--provider agent:<id>` works for any known agent without turning it on first: typing the command is the choice.

Agent mode needs git: Orka snapshots the folder around every request (see below). Without snapshots (git missing, `orka.trackCommandChanges` / `"trackCommandChanges"` off, or a folder too large to snapshot quickly), the agent does not start.

## Supported agents

The commands below are listed in Orka's source (`packages/core/src/acp/catalog.ts`) and were checked against each vendor's documentation in October 2026. Orka shows the install command; it never runs it.

| Agent | id | Command Orka runs | Install | Sign in (the vendor's own login) |
|---|---|---|---|---|
| **Gemini CLI** (Google) | `gemini` | `gemini --acp` | `npm install -g @google/gemini-cli` | Run `gemini` in a terminal and choose how to sign in (Google account, Gemini API key or Vertex AI) |
| **Codex** through the `codex-acp` adapter (OpenAI) | `codex` | `codex-acp` | `npm install -g @agentclientprotocol/codex-acp` | `codex login` (a ChatGPT plan or an API key) |
| **GitHub Copilot CLI** (GitHub) | `copilot` | `copilot --acp --stdio` | `npm install -g @github/copilot` (Windows: `winget install GitHub.Copilot`) | `copilot login` |
| **Cursor CLI** (Cursor) | `cursor` | `cursor-agent acp` (or `agent acp`, its newer name) | `curl https://cursor.com/install -fsS \| bash` (Windows: `irm 'https://cursor.com/install?win32=true' \| iex`) | `agent login` |

What Orka shows with each agent, and the terms it is used under (`packages/core/src/acp/policy.ts`):

| Agent | Note | Terms | Status |
|---|---|---|---|
| Gemini CLI | Runs your installed Gemini CLI in its ACP mode. Orka never uses Gemini CLI's sign-in itself: Google's terms forbid other software from using it. Google moved unpaid and Google One accounts from Gemini CLI to Antigravity. | [Gemini CLI terms and privacy](https://geminicli.com/docs/resources/tos-privacy/) · [ACP mode](https://geminicli.com/docs/cli/acp-mode/) | |
| Codex | Runs the codex-acp adapter (Apache-2.0) you installed. Sign in with Codex itself, with a ChatGPT plan or an API key. | [OpenAI terms of use](https://openai.com/policies/terms-of-use/) · [codex-acp](https://github.com/agentclientprotocol/codex-acp) | |
| GitHub Copilot CLI | Runs your installed GitHub Copilot CLI as an ACP server. GitHub documents this mode for other clients; it is a public preview and may change. | [GitHub terms for additional products and features](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features) · [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) | Public preview |
| Cursor CLI | Runs your installed Cursor CLI (`agent acp`), which Cursor documents for custom clients. | [Cursor terms of service](https://cursor.com/terms-of-service) · [ACP](https://cursor.com/docs/cli/acp) | |

Signing in always happens in the vendor's own login command or app. The only exception Orka allows is Cursor's own `cursor_login` sign-in method, which Orka asks the agent to start over ACP when you ask for it; the sign-in itself still happens in Cursor's own flow, and the result stays inside Cursor CLI. Whether an agent is signed in shows on the first request: if it is not, Orka names the vendor's login command to run in a terminal.

## What Orka keeps doing

- **Permission prompts.** When the agent asks for permission before one of its tool calls, Orka decides with its own rules (the permission mode and your per-category overrides) and asks you where they say so, exactly as for its own tools. Orka always answers "allow once" or "reject once": an *always allow* you give becomes Orka's own grant for the session, so the next request is decided by Orka again. A request to switch the agent's mode always asks, because a mode switch could turn the agent's own approvals off. Once the task has read a file that may hold secrets, the agent's web access asks too.
- **File access inside the workspace only.** The agent reads and writes files through Orka. Paths outside the workspace, and links inside it that lead outside it, are refused. Writes follow Orka's permission rules, are recorded in Changes before they happen, and your `afterEdit` hooks run after them.
- **Terminal commands.** Commands the agent runs through Orka run in Orka's shell and are classified like Orka's own `run_command`: risky commands (`rm -rf`, `git push`, downloads, writes outside the workspace, ...) ask.
- **Changes and revert, including files the agent wrote itself.** Some agents also change files with their own tools, without asking Orka. Orka snapshots the workspace in its private git directory before and after every request, so whatever changed shows up in Changes (CLI: `/diff`) and can be kept or reverted like any other change (CLI: `/undo`). This is why agent mode needs snapshots.
- **Go back (rewind).** Going back restores the files as usual. The agent's own conversation cannot be cut back, so the next request starts a fresh agent session with a summary of where the task stands.
- **The Supervisor's final review.** The Supervisor reviews the result with the task's real diff when the agent says it is done; if it is not convinced, its correction goes to the agent as the next prompt. It cannot step in during the agent's turn, so with an agent as the main agent it reviews only the final result, whatever its frequency setting. It runs on its own model provider (in the CLI: `--supervisor` or `"supervisor": { "provider": ... }`).
- **Your checks.** `beforeFinish` hooks and the "build and test before finishing" check still run, and their results go back to the agent.
- **Stop.** Stopping a request cancels the agent's turn; an agent that does not end its turn within 5 seconds is stopped.
- **Usage not reported.** Agents do not report their token use. Orka counts the requests and shows the tokens as *not reported*; the token budget cannot pause an agent.
- **Task history.** The conversation is kept as plain text (your requests, the agent's answers and a short activity summary), so a task can continue on a model provider later. An agent that takes over a task already under way gets a summary of where it stands.

Agent processes keep running between requests (starting one takes seconds): one per agent and folder, by default at most 4 at a time, and an idle one stops after 15 minutes. They stop when Orka closes.

## What agent mode leaves out

The agent brings its own loop, model and context, so the parts of Orka that need a plain model are skipped while an agent is the main agent:

- no **light model** for simple questions and no **fallback** provider;
- no **compaction**: the agent keeps its own context (`/compact` says so);
- no **learned lessons** in `.project-ai/lessons.md`;
- no `ask_supervisor` tool and no Orka **sub-agents** (the agent uses its own);
- no MCP servers from Orka: the agent uses the ones its own configuration names;
- no model choice: the agent uses the model set in its own settings.

## Compliance rules

These rules hold for every agent and are enforced in code (`packages/core/src/acp/`) and checked by tests (`packages/core/test/compliance.test.ts`):

- **Orka never reads, stores or forwards an agent's sign-in.** It does not touch OAuth or subscription tokens or the vendor's credential files, and never sets an environment variable for the agent whose name looks like a key, token, secret or password. (The agent inherits your environment, as any program you start does.)
- **Orka only runs the unmodified program you installed**, found on `PATH` or at the path you set.
- **Orka never downloads an agent.** Install commands are shown to you and never run, and the catalog starts no agent through a download launcher such as `npx`.
- **Orka never turns on an agent's "approve everything" mode** (no `--yolo`, no permission bypass). It answers each permission request once, with its own rules.
- Signing in happens in the vendor's own login. Orka asks an agent to sign in over ACP only when you ask, and only with a method its policy lists (today only Cursor's `cursor_login`).

Your use of each agent is governed by that vendor's terms (linked above); Orka is not affiliated with Google, OpenAI, GitHub or Cursor.

## Agents that are not in the catalog

| Agent | Why it is left out |
|---|---|
| **Antigravity** (Google) | Google's terms do not allow using Antigravity through third-party software on consumer plans. |
| **Claude ACP adapter** (`claude-agent-acp`) | The Claude ACP adapter's licence is unclear. Claude stays available through the Claude API provider and the opt-in Claude Code provider. |

## Adding your own ACP agent

Any program that speaks ACP (protocol version 1) on stdio can be added as a custom agent, **on your own responsibility**: Orka runs exactly the command you enter, and it is up to you to make sure your use follows that agent's terms. Orka still applies everything above (permissions, workspace-only files, snapshots, the Supervisor).

```json
"agentClis": {
  "enabled": ["custom:my-agent"],
  "custom": [{ "name": "My agent", "command": "my-agent", "args": ["--acp"] }]
}
```

(In VS Code: `orka.agentClis.custom` and `orka.agentClis.enabled`.) The agent's id is `custom:` followed by its name in lowercase, with every run of other characters turned into a dash: `My agent` becomes `custom:my-agent`. The part after `custom:` may have at most 40 letters, digits and dashes. `command` is a program on `PATH` or a full path; `args` are the arguments that start its ACP server. An older Gemini CLI that only knows `--experimental-acp` can be added this way.

## A note on Gemini CLI

On 2026-06-18 Google moved unpaid and Google One users of Gemini CLI to Antigravity. If your Gemini CLI no longer works with your account, that comes from Google's change; check Gemini CLI's documentation for the sign-in options available to you. Antigravity itself cannot be used through Orka (see above).

Orka never uses Gemini CLI's sign-in itself: it does not read Gemini CLI's credentials or call Google with them, because Google's terms forbid other software from using that sign-in. Orka only starts your installed Gemini CLI, which signs in on its own. Orka's own Gemini API provider, with a Gemini API key, is a separate option and is not affected.

## Troubleshooting

| Message | What to do |
|---|---|
| *Gemini CLI is not installed. Install it with: ...* or *... was not found at ...* | Install it with the command shown, or set its path in `agentClis.paths` |
| *Gemini CLI is not signed in. Run "gemini" in a terminal ...* | Run the vendor's login command in a terminal, sign in there, then send your message again |
| *... cannot start: ...*, *... needs command snapshots ...* or *... needs git ...* | Install git, and turn on `trackCommandChanges` (VS Code: `orka.trackCommandChanges`); a folder too large to snapshot quickly cannot be used in agent mode |
| *... is not turned on* (CLI) | Add its id to `agentClis.enabled`, or choose it with `--provider agent:<id>` |
| *4 agent processes are already working* | Wait for one to finish or stop it; by default at most 4 agent processes run at a time |
