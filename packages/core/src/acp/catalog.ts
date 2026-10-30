import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { childEnv, findExecutable, resolveCommand } from '../host/commands';
import { killTree } from '../host/processes';
import { t } from '../i18n';
import type { AcpLaunchSpec } from './AcpClient';

/**
 * Coding agents Orka can drive as its main agent over ACP. Every command Orka runs for them is
 * listed here, so it is reviewed in Orka's source; each entry names its row in AGENT_POLICIES.
 * The commands were checked against each vendor's documentation (October 2026).
 */
export interface AgentCliEntry {
  /** "gemini", or "custom:<name>" for an agent the user added. */
  id: string;
  label: string;
  vendor: string;
  /** Executable looked up on PATH. */
  bin: string;
  /** Other names of the same program, tried in order when `bin` is not found. */
  altBins?: readonly string[];
  /** Starts the agent's ACP server on stdio. */
  acpArgs: readonly string[];
  /** Prints the version; empty when the program has no such flag (the check then only finds it). */
  versionArgs: readonly string[];
  /**
   * The vendor's own sign-in, which the user runs in a terminal: these arguments for the agent's
   * own program, or for `bin`, another program of the vendor's (with how to install it).
   */
  login?: { args: readonly string[]; bin?: string; installHint?: string };
  /** How to install it, shown to the user (Orka never runs it). */
  installHint: string;
  /** The install hint for Windows, when it differs. */
  installHintWindows?: string;
  docsUrl: string;
  /** Its row in AGENT_POLICIES. */
  policy: string;
  kind: 'builtin' | 'custom';
}

export const AGENT_CLIS: readonly AgentCliEntry[] = [
  {
    id: 'gemini',
    label: 'Gemini CLI',
    vendor: 'Google',
    bin: 'gemini',
    // Builds before "--acp" used "--experimental-acp" (now deprecated); those can be added as a custom agent.
    acpArgs: ['--acp'],
    versionArgs: ['--version'],
    // Sign-in is a choice inside the interactive CLI (Google account, API key or Vertex AI).
    login: { args: [] },
    installHint: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://geminicli.com/docs/cli/acp-mode/',
    policy: 'google',
    kind: 'builtin',
  },
  {
    id: 'codex',
    label: 'Codex (codex-acp)',
    vendor: 'OpenAI',
    bin: 'codex-acp',
    acpArgs: [],
    versionArgs: ['--version'],
    // The adapter uses the Codex CLI's sign-in, so "codex login" needs the Codex CLI itself.
    login: { bin: 'codex', args: ['login'], installHint: 'npm install -g @openai/codex' },
    installHint: 'npm install -g @agentclientprotocol/codex-acp @openai/codex',
    docsUrl: 'https://github.com/agentclientprotocol/codex-acp',
    policy: 'openai',
    kind: 'builtin',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    vendor: 'GitHub',
    bin: 'copilot',
    acpArgs: ['--acp', '--stdio'],
    versionArgs: ['--version'],
    login: { args: ['login'] },
    installHint: 'npm install -g @github/copilot',
    installHintWindows: 'winget install GitHub.Copilot',
    docsUrl: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server',
    policy: 'github',
    kind: 'builtin',
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    vendor: 'Cursor',
    // Cursor's docs name the program "agent"; "cursor-agent" is its older, unambiguous name and is tried first.
    bin: 'cursor-agent',
    altBins: ['agent'],
    acpArgs: ['acp'],
    versionArgs: ['--version'],
    login: { args: ['login'] },
    installHint: 'curl https://cursor.com/install -fsS | bash',
    installHintWindows: "irm 'https://cursor.com/install?win32=true' | iex",
    docsUrl: 'https://cursor.com/docs/cli/acp',
    policy: 'cursor',
    kind: 'builtin',
  },
];

export function agentCli(id: string): AgentCliEntry | undefined {
  return AGENT_CLIS.find((a) => a.id === id);
}

/** An ACP agent the user added: a name and the exact command line that starts its ACP server. */
export interface CustomAgentDefinition {
  name: string;
  command: string;
  args?: readonly string[];
}

export function customAgentEntry(definition: CustomAgentDefinition): AgentCliEntry {
  // At most 40 characters, as the settings and the CLI's config accept ids.
  const slug =
    definition.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'agent';
  return {
    id: `custom:${slug}`,
    label: definition.name.trim() || slug,
    vendor: '',
    bin: definition.command.trim(),
    acpArgs: [...(definition.args ?? [])],
    versionArgs: [],
    installHint: '',
    docsUrl: '',
    policy: 'custom',
    kind: 'custom',
  };
}

/** The agent's executable: the user's path when set, else the first of its names on PATH. */
export function resolveAgentExecutable(entry: AgentCliEntry, overridePath?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const find = (name: string) => (/[\\/]/.test(name) ? (existsSync(name) ? path.resolve(name) : undefined) : findExecutable(name, env, platform));
  const explicit = overridePath?.trim();
  if (explicit) return find(explicit);
  for (const name of [entry.bin, ...(entry.altBins ?? [])]) {
    const found = name && find(name);
    if (found) return found;
  }
  return undefined;
}

/**
 * The vendor's sign-in as a program by its full path and its arguments: the agent's own program
 * (the one Orka runs, so also the user's path when set), or the vendor's other program on PATH.
 * Undefined when the agent has none or the program is not installed.
 */
export function agentLogin(
  entry: AgentCliEntry,
  overridePath?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } | undefined {
  if (!entry.login) return undefined;
  const file = entry.login.bin ? findExecutable(entry.login.bin, env, platform) : resolveAgentExecutable(entry, overridePath, env, platform);
  return file ? { file, args: [...entry.login.args] } : undefined;
}

/**
 * The sign-in as the user would type it, for hints: by the program's name, or by its path when
 * the user set one. `executable` is the agent's program when it was found.
 */
export function loginCommand(entry: AgentCliEntry, overridePath?: string, executable?: string): string | undefined {
  if (!entry.login) return undefined;
  const explicit = !entry.login.bin && overridePath?.trim();
  const program = entry.login.bin ?? (explicit ? (/\s/.test(explicit) ? `"${explicit}"` : explicit) : executable ? programName(executable) : entry.bin);
  return [program, ...entry.login.args].join(' ');
}

function programName(file: string): string {
  const base = path.basename(file);
  return base.replace(/\.(?:exe|cmd|bat|com|ps1)$/i, '');
}

/** How to start the agent in `cwd`; throws a user-facing error when it is not installed. */
export function agentLaunchSpec(entry: AgentCliEntry, cwd: string, overridePath?: string): AcpLaunchSpec {
  const command = resolveAgentExecutable(entry, overridePath);
  if (!command) {
    throw new Error(
      entry.installHint
        ? t('{agent} was not found. Install it ({command}) or set its path in the settings.', { agent: entry.label, command: installHint(entry) })
        : t('{agent} was not found at "{path}".', { agent: entry.label, path: overridePath?.trim() || entry.bin }),
    );
  }
  return { agentId: entry.id, label: entry.label, command, args: [...entry.acpArgs], cwd, loginCommand: loginCommand(entry, overridePath, command) };
}

export function installHint(entry: AgentCliEntry, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && entry.installHintWindows ? entry.installHintWindows : entry.installHint;
}

export interface AgentCliStatus {
  state: 'ready' | 'not_found' | 'error';
  version?: string;
  executable?: string;
  detail?: string;
}

/**
 * Is the agent installed, and which version: runs only its version flag. Whether the user is
 * signed in shows on the first prompt (an auth error names the vendor's login command).
 */
export async function checkAgentCli(entry: AgentCliEntry, overridePath?: string, timeoutMs = 20_000): Promise<AgentCliStatus> {
  const executable = resolveAgentExecutable(entry, overridePath);
  if (!executable) return { state: 'not_found' };
  if (!entry.versionArgs.length) return { state: 'ready', executable };
  const { file, args, shell } = resolveCommand(executable, [...entry.versionArgs]);
  // An npm shim starts "node" through cmd.exe, which looks in the current folder first: run the
  // check in the home folder, and tell cmd.exe not to look there at all.
  const env = childEnv({ ...process.env });
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(file, args, { cwd: homedir(), env, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const done = (status: AgentCliStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      done({ state: 'error', executable, detail: t('{agent} did not answer within {n} seconds.', { agent: entry.label, n: Math.round(timeoutMs / 1000) }) });
    }, timeoutMs);
    child.stdout.on('data', (data: Buffer) => (output += data.toString('utf8')));
    child.stderr.on('data', (data: Buffer) => (output += data.toString('utf8')));
    child.on('error', (error) => done({ state: 'error', executable, detail: error.message }));
    child.on('close', (code) => {
      const line = output.trim().split(/\r?\n/).find((l) => l.trim()) ?? '';
      if (code === 0) done({ state: 'ready', executable, version: /\d+\.\d+[\w.+-]*/.exec(line)?.[0] ?? (line.slice(0, 60) || undefined) });
      else done({ state: 'error', executable, detail: output.trim().split(/\r?\n/).slice(-3).join(' ') || `exit code ${code}` });
    });
  });
}
