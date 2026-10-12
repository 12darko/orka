# Security policy

Orka runs AI agents that edit files and execute commands on your machine, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub's [private vulnerability reporting](https://github.com/12darko/orka/security/advisories/new) instead. Include:

- what an attacker can do and under which conditions,
- the steps or a proof of concept to reproduce it,
- the Orka version or commit, and your operating system.

You will get an answer within a few days. Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## Scope

Examples of what counts as a vulnerability:

- a way for a model, a web page, a file in the workspace or an MCP server to run commands or edit files **without** the approval the current permission mode requires,
- a command classified as safe that actually writes outside the workspace or does something destructive,
- the desktop app's local server accepting requests from anything other than its own window,
- API keys leaking into logs, task history, prompts or the network.

Out of scope: what a model does after you approved it, or anything the *Autonomous* mode is documented to allow.

## Supported versions

Only the latest release on the `main` branch gets security fixes.
