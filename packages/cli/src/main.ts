import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  copyToClipboard,
  createProvider,
  DEFAULT_SUBAGENTS,
  externalAgent,
  findExecutable,
  Handoff,
  handoffBrief,
  userRequests,
  type ExternalAgent,
  FileTaskStore,
  getLocale,
  loadSkills,
  McpManager,
  MODEL_CATALOG,
  newTaskId,
  NodeHost,

  Orchestrator,
  PermissionManager,
  PROVIDERS,
  setLocale,
  ShadowGit,
  systemLocale,
  t,
  type AIProvider,
  type AttachedImage,
  type OrchestratorSettings,
  type PermissionMode,
  type RunEndReason,
  type Skill,
  type SupervisorSettings,
  type TaskSnapshot,
} from '@orka/core';
import { HELP, HELP_TR, parseArgs, type CliArgs } from './args';
import { CONFIG_FILE, defaultProvider, isProviderKind, loadConfig, ORKA_HOME, parseChoice, providerConfig, type AgentChoice, type OrkaConfig } from './config';
import { Approver, colorDiff, formatTokens, question, Renderer, style, type Style } from './terminal';

declare const ORKA_VERSION: string;
const VERSION = typeof ORKA_VERSION === 'string' ? ORKA_VERSION : '0.0.0-dev';

const IMAGE_TYPES: Record<string, AttachedImage['mediaType']> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_ATTACHMENT_BYTES = 256_000;
const MAX_IMAGE_BYTES = 5_000_000;

/** One Orka session in a folder: providers, the orchestrator, skills, MCP and task history. */
class Session {
  readonly host: NodeHost;
  readonly permissions: PermissionManager;
  readonly orchestrator: Orchestrator;
  readonly store: FileTaskStore;
  /** Private git snapshots of the folder: files changed by commands and by hand-offs become revertible. */
  readonly snapshots: ShadowGit;
  skills: Skill[] = [];
  main: AgentChoice;
  private providers = new Map<string, AIProvider>();
  private mcp?: McpManager;
  private task = { id: newTaskId(), createdAt: new Date().toISOString(), title: '' };

  constructor(
    readonly root: string,
    private readonly config: OrkaConfig,
    main: AgentChoice,
    private readonly supervisorChoice: AgentChoice | undefined,
    mode: PermissionMode,
    approver: Approver,
  ) {
    this.main = main;
    this.host = new NodeHost({ workspaceRoot: root, editorName: `Orka CLI ${VERSION}`, approve: (r) => approver.approve(r), browserPath: config.browserPath });
    this.permissions = new PermissionManager(mode);
    const key = createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 12);
    this.store = new FileTaskStore(path.join(ORKA_HOME, 'tasks', key));
    if (config.mcpServers && Object.keys(config.mcpServers).length) {
      this.mcp = new McpManager();
      this.mcp.sync(config.mcpServers);
    }
    this.snapshots = new ShadowGit(root, path.join(ORKA_HOME, 'snapshots', `${key}.git`));
    this.orchestrator = new Orchestrator({
      host: this.host,
      getProvider: () => this.provider('main', this.main),
      permissions: this.permissions,
      getSettings: () => this.settings(),
      subagents: {
        getProfiles: () => (config.subagents === false ? [] : DEFAULT_SUBAGENTS),
        getProvider: () => this.provider('main', this.main),
      },
      supervisor: this.supervisorChoice
        ? { getProvider: () => this.provider('supervisor', this.supervisorChoice!), getSettings: () => this.supervisorSettings() }
        : undefined,
      skills: () => this.activeSkills(),
      getLightProvider: () => (config.light ? this.provider('light', config.light) : undefined),
      getFallbackProvider: () => (config.fallback ? this.provider('fallback', config.fallback) : undefined),
      commandSnapshots: config.trackCommandChanges === false ? undefined : this.snapshots,
      getExtraTools: this.mcp ? () => this.mcp!.tools() : undefined,
    });
  }

  private settings(): OrchestratorSettings {
    const c = this.config;
    return {
      maxIterations: clamp(c.maxIterations, 1, 500, 60),
      autoVerify: true,
      commandTimeoutMs: clamp(c.commandTimeoutSeconds, 5, 3600, 180) * 1000,
      customInstructions: c.customInstructions,
      maxParallelSubagents: 3,
      compaction: { auto: true, thresholdTokens: 150_000 },
      tokenBudget: c.tokenBudget && c.tokenBudget > 0 ? c.tokenBudget : undefined,
    };
  }

  private supervisorSettings(): SupervisorSettings {
    const s = this.config.supervisor ?? {};
    return { enabled: true, frequency: s.frequency ?? 'checkpoints', maxInterventions: clamp(s.maxInterventions, 1, 50, 5) };
  }

  /** A provider per role and choice, created once and reused (providers keep connections and caches). */
  provider(role: string, choice: AgentChoice): AIProvider {
    const config = providerConfig(choice, this.config);
    if ('error' in config) throw new Error(config.error);
    const key = `${role}:${JSON.stringify(config)}`;
    let provider = this.providers.get(key);
    if (!provider) {
      provider = createProvider(config);
      this.providers.set(key, provider);
    }
    return provider;
  }

  async loadSkills(): Promise<string[]> {
    const loaded = await loadSkills([
      { dir: path.join(__dirname, 'skills'), source: 'builtin' },
      { dir: path.join(ORKA_HOME, 'skills'), source: 'user' },
    ]);
    this.skills = loaded.skills;
    return loaded.errors;
  }

  activeSkills(): Skill[] {
    if (this.config.skills?.enabled === false) return [];
    const disabled = new Set(this.config.skills?.disabled ?? []);
    return this.skills.filter((s) => !disabled.has(s.name));
  }

  async run(text: string, skills: Skill[] = []): Promise<RunEndReason> {
    if (!this.task.title) this.task.title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    const { attachments, images } = collectAttachments(text, this.root);
    const reason = await this.orchestrator.run(text, undefined, attachments, { skills, images });
    await this.save();
    return reason;
  }

  async save(): Promise<void> {
    const state = this.orchestrator.snapshot();
    if (!state.messages.length) return;
    const snapshot: TaskSnapshot = {
      version: 1,
      id: this.task.id,
      title: this.task.title || 'Task',
      createdAt: this.task.createdAt,
      updatedAt: new Date().toISOString(),
      ...state,
    };
    await this.store.save(snapshot).catch(() => undefined);
  }

  /** Continue the most recent task in this folder. */
  async resume(): Promise<TaskSnapshot | undefined> {
    const [latest] = await this.store.list();
    const snapshot = latest ? await this.store.load(latest.id) : undefined;
    if (!snapshot) return undefined;
    this.orchestrator.restore(snapshot);
    this.task = { id: snapshot.id, createdAt: snapshot.createdAt, title: snapshot.title };
    return snapshot;
  }

  async newTask(): Promise<void> {
    await this.save();
    this.orchestrator.reset();
    this.task = { id: newTaskId(), createdAt: new Date().toISOString(), title: '' };
  }

  dispose(): void {
    this.orchestrator.dispose();
    this.mcp?.dispose();
    this.host.stopAllProcesses();
    for (const provider of this.providers.values()) provider.dispose?.();
  }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/** `@path` in a request attaches that workspace file (text) or image. */
export function collectAttachments(text: string, root: string): { attachments: Array<{ path: string; content: string }>; images: AttachedImage[] } {
  const attachments: Array<{ path: string; content: string }> = [];
  const images: AttachedImage[] = [];
  for (const m of text.matchAll(/(?:^|\s)@("[^"]+"|\S+)/g)) {
    const rel = m[1].replace(/^"|"$/g, '').replace(/[.,;:!?)]+$/, '');
    const abs = path.resolve(root, rel);
    const inside = path.relative(root, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !existsSync(abs)) continue;
    const stat = statSync(abs);
    if (!stat.isFile()) continue;
    const mediaType = IMAGE_TYPES[path.extname(abs).toLowerCase()];
    if (mediaType) {
      if (stat.size <= MAX_IMAGE_BYTES && images.length < 5) images.push({ name: path.basename(abs), mediaType, data: readFileSync(abs).toString('base64') });
    } else if (stat.size <= MAX_ATTACHMENT_BYTES && !attachments.some((a) => a.path === inside)) {
      const content = readFileSync(abs, 'utf8');
      if (!content.includes('\u0000')) attachments.push({ path: inside.split(path.sep).join('/'), content });
    }
  }
  return { attachments, images };
}

// ---------------------------------------------------------------- hand-off

/** Errors that mean the provider's quota or session limit is used up. */
const USAGE_LIMIT = /usage limit|rate.?limit|session limit|quota|\b429\b|too many requests/i;

/**
 * Continue the task in an external agent with no API (Freebuff): run it in this terminal with a
 * task summary to paste, then pick up the files it changed so /diff and /undo cover them.
 */
async function handOff(session: Session, agent: ExternalAgent, text: string, rl: readline.Interface | undefined, s: Style): Promise<void> {
  const out = (line = '') => io.stdout.write(`${line}\n`);
  const exe = findExecutable(agent.command);
  if (!exe) {
    out(s.yellow(t('{agent} is not installed. Install it with: {command}', { agent: agent.label, command: agent.installCommand })));
    out(s.dim(agent.url));
    return;
  }
  if (!rl || !io.stdin.isTTY) {
    out(s.yellow(t('{agent} needs an interactive terminal.', { agent: agent.label })));
    return;
  }
  const orchestrator = session.orchestrator;
  const handoff = new Handoff(agent, session.root, session.snapshots, orchestrator.changes);
  const tracked = await handoff.begin();
  const requests = [...userRequests(orchestrator.history), ...(text ? [text] : [])];
  const brief = handoffBrief({ requests, plan: orchestrator.currentPlan, changedFiles: (await orchestrator.changes.list()).map((c) => c.relPath) });
  if (brief) {
    out(s.bold(copyToClipboard(brief) ? t('Task summary (copied - paste it into {agent}):', { agent: agent.label }) : t('Task summary (paste it into {agent}):', { agent: agent.label })));
    out(s.dim(brief));
  }
  if (!tracked) out(s.yellow(t("Orka can't track what {agent} changes: {reason}.", { agent: agent.label, reason: handoff.untrackedReason ?? t('snapshots are off') })));
  out(s.dim(t('Starting {agent}. Quit it to come back to Orka.', { agent: agent.label })));
  // Give the terminal to the other agent: no raw mode, and Ctrl+C belongs to it.
  const wasRaw = io.stdin.isRaw;
  const ignoreInterrupt = () => undefined;
  rl.pause();
  io.stdin.setRawMode?.(false);
  process.on('SIGINT', ignoreInterrupt);
  try {
    const script = /\.(cmd|bat)$/i.test(exe);
    spawnSync(script ? `"${exe}"` : exe, [], { cwd: session.root, stdio: 'inherit', shell: script });
  } finally {
    process.off('SIGINT', ignoreInterrupt);
    if (wasRaw) io.stdin.setRawMode?.(true);
    rl.resume();
  }
  const changed = await handoff.collect().catch(() => []);
  if (!changed.length) {
    out(s.dim(t('{agent} closed without changing any files.', { agent: agent.label })));
    return;
  }
  const files = changed.map((ch) => ch.path);
  orchestrator.addNote(`The user worked on this task in ${agent.label} (another coding agent) and it changed: ${files.join(', ')}. Read these files before building on them.`);
  out(t('{agent} changed {n} file(s):', { agent: agent.label, n: files.length }));
  for (const ch of changed) out(`  ${ch.status === 'added' ? s.green('A') : ch.status === 'deleted' ? s.red('D') : s.yellow('M')} ${ch.path}`);
  out(s.dim(t('/diff shows them, /undo reverts them.')));
}

// ---------------------------------------------------------------- commands

function printModels(provider: string | undefined, s: Style): number {
  const kinds = provider ? [provider] : Object.keys(MODEL_CATALOG);
  for (const kind of kinds) {
    const models = MODEL_CATALOG[kind as keyof typeof MODEL_CATALOG];
    if (!models) {
      io.stderr.write(`${t('Unknown provider')}: ${kind}\n`);
      return 1;
    }
    io.stdout.write(`${s.bold(PROVIDERS[kind as keyof typeof PROVIDERS]?.label ?? kind)} ${s.dim(`(${kind})`)}\n`);
    let family = '';
    for (const m of models) {
      if (m.family !== family) {
        family = m.family;
        io.stdout.write(`  ${s.cyan(family)}\n`);
      }
      io.stdout.write(`    ${m.id.padEnd(28)} ${s.dim(m.label + (m.note ? ` - ${t(m.note)}` : ''))}\n`);
    }
  }
  return 0;
}

function printConfig(config: OrkaConfig, error: string | undefined, s: Style): number {
  const out = (line = '') => io.stdout.write(`${line}\n`);
  out(`${s.bold(t('Config'))}: ${CONFIG_FILE}${existsSync(CONFIG_FILE) ? '' : s.dim(` (${t('not created yet - defaults in use')})`)}`);
  if (error) out(s.red(error));
  const main = defaultProvider(config);
  out(`${t('Provider')}: ${main ?? s.yellow(t('none found'))}${config.model ? ` (${config.model})` : ''}`);
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', ...(config.custom ?? []).map((c) => c.apiKeyEnv).filter((k): k is string => !!k)];
  out(`${t('API keys in the environment')}: ${keys.filter((k) => process.env[k]?.trim()).join(', ') || '-'}`);
  out(`${t('Skills')}: ${path.join(ORKA_HOME, 'skills')}`);
  out(`MCP: ${Object.keys(config.mcpServers ?? {}).join(', ') || '-'}`);
  out();
  out(s.dim(t('Example config:')));
  out(
    s.dim(
      JSON.stringify(
        {
          provider: 'claude',
          model: 'claude-opus-5-5',
          mode: 'balanced',
          supervisor: { enabled: true, model: 'claude-sonnet-5-5', frequency: 'checkpoints' },
          light: { provider: 'claude', model: 'claude-haiku-4-5' },
          fallback: { provider: 'gemini', model: 'gemini-3.8-flash' },
          custom: [{ id: 'ollama', label: 'Ollama', baseURL: 'http://localhost:11434/v1', model: 'qwen3-coder' }],
          claudeCode: { enabled: false },
        },
        null,
        2,
      ),
    ),
  );
  return 0;
}

const COMMANDS: Array<[string, string]> = [
  ['/new', 'Start a new task'],
  ['/diff', 'Show what the agent changed in this task'],
  ['/undo', 'Revert all changes of this task'],
  ['/compact', 'Summarize the conversation to save tokens'],
  ['/mode [ask|balanced|autonomous]', 'Show or change the permission mode'],
  ['/model [provider:]model', 'Show or change the main model'],
  ['/usage', 'Tokens and cost of this task, per agent'],
  ['/skills', 'List skills; /<skill> <request> uses one'],
  ['/freebuff [task]', 'Continue in Freebuff (free); Orka then shows what it changed'],
  ['/exit', 'Leave (the task is saved; orka -c continues it)'],
];

type SlashResult = 'exit' | 'handled' | { run: string; skills: Skill[] } | { handoff: ExternalAgent; text: string };

async function slash(line: string, session: Session, rl: readline.Interface | undefined, s: Style): Promise<SlashResult> {
  const out = (text = '') => io.stdout.write(`${text}\n`);
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case 'exit':
    case 'quit':
      return 'exit';
    case 'help':
    case '?':
      for (const [name, what] of COMMANDS) out(`  ${s.cyan(name.padEnd(34))} ${t(what)}`);
      out(s.dim(`  ${t('@path attaches a file or image. Ctrl+C stops the running request.')}`));
      return 'handled';
    case 'new':
    case 'clear':
      await session.newTask();
      out(s.dim(t('New task.')));
      return 'handled';
    case 'diff': {
      const diff = await session.orchestrator.changes.unifiedDiffs(200_000);
      out(diff.trim() ? colorDiff(diff, s) : s.dim(t('No changes in this task.')));
      return 'handled';
    }
    case 'undo': {
      const files = await session.orchestrator.changes.list();
      if (!files.length) {
        out(s.dim(t('No changes in this task.')));
        return 'handled';
      }
      if (!rl) {
        out(s.yellow(t('/undo asks first, so it needs an interactive terminal.')));
        return 'handled';
      }
      const answer = (await question(rl, `${s.yellow('?')} ${t('Revert {n} changed file(s)?', { n: files.length })} (y/n) `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes' && answer !== 'e' && answer !== 'evet') return 'handled';
      const reverted = await session.orchestrator.changes.revertAll();
      out(s.green(`${t('Reverted')}: ${reverted.join(', ')}`));
      return 'handled';
    }
    case 'compact':
      await session.orchestrator.compact();
      return 'handled';
    case 'mode':
      if (arg) {
        if (!['ask', 'balanced', 'autonomous'].includes(arg)) out(s.red(t('Unknown mode: {mode}', { mode: arg })));
        else session.permissions.setMode(arg as PermissionMode);
      }
      out(`${t('Mode')}: ${session.permissions.getMode()}`);
      return 'handled';
    case 'model': {
      if (arg) {
        const choice = arg.includes(':') ? parseChoice(arg) : { provider: session.main.provider, model: arg };
        const config = providerConfig(choice, loadConfig().config);
        if ('error' in config) out(s.red(config.error));
        else session.main = choice;
      }
      out(`${t('Model')}: ${session.main.provider}${session.main.model ? `:${session.main.model}` : ''}`);
      return 'handled';
    }
    case 'usage': {
      const rows = session.orchestrator.usageByAgent;
      if (!rows.length) out(s.dim(t('No tokens used in this task yet.')));
      for (const r of rows) {
        const u = r.usage;
        out(`  ${r.agent.padEnd(12)} ${`${r.provider}:${r.model}`.padEnd(34)} ${formatTokens(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens).padStart(7)} in ${formatTokens(u.outputTokens).padStart(7)} out  ${s.dim(`${r.calls}×`)}`);
      }
      return 'handled';
    }
    case 'skills': {
      const active = new Set(session.activeSkills().map((k) => k.name));
      for (const skill of session.skills) out(`  ${(active.has(skill.name) ? s.cyan : s.dim)(`/${skill.name}`.padEnd(22))} ${s.dim(skill.description)}`);
      if (!session.skills.length) out(s.dim(t('No skills found.')));
      return 'handled';
    }
    default: {
      const external = externalAgent(cmd);
      if (external) return { handoff: external, text: arg };
      const skill = session.activeSkills().find((k) => k.name === cmd);
      if (skill) return { run: arg || t('Use the {name} skill.', { name: skill.name }), skills: [skill] };
      out(s.red(t('Unknown command: /{name} (see /help)', { name: cmd })));
      return 'handled';
    }
  }
}

// ---------------------------------------------------------------- main

/** The terminal the CLI talks to: the process's own, or (in tests) streams that act as one. */
export interface CliIO {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?(mode: boolean): unknown };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
}

let io: CliIO = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };

export async function main(argv: readonly string[], streams: CliIO = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  io = streams;
  const parsed = parseArgs(argv);
  const { config, error: configError } = loadConfig();
  const lang = 'error' in parsed ? undefined : parsed.lang;
  const language = lang ?? (config.language && config.language !== 'auto' ? config.language : undefined);
  setLocale(language ?? systemLocale());
  const color = !!io.stdout.isTTY && !process.env.NO_COLOR;
  const s = style(color);

  if ('error' in parsed) {
    io.stderr.write(`orka: ${parsed.error}\n${t('Run orka --help for usage.')}\n`);
    return 2;
  }
  const args: CliArgs = parsed;
  if (args.help) {
    io.stdout.write(`${getLocale() === 'tr' ? HELP_TR : HELP}\n`);
    return 0;
  }
  if (args.version) {
    io.stdout.write(`orka ${VERSION}\n`);
    return 0;
  }
  if (args.command === 'models') return printModels(args.commandArg, s);
  if (args.command === 'config') return printConfig(config, configError, s);
  if (configError) io.stderr.write(`${s.yellow('!')} ${configError}\n`);

  const root = path.resolve(args.cwd ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    io.stderr.write(`orka: ${t('Not a folder: {path}', { path: root })}\n`);
    return 2;
  }

  const providerId = args.provider ?? defaultProvider(config);
  if (!providerId) {
    io.stderr.write(
      `orka: ${t('No provider available. Install and log in to Claude Code (claude), or set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY.')}\n`,
    );
    return 2;
  }
  const main: AgentChoice = { provider: providerId, model: args.model ?? (args.provider && args.provider !== config.provider ? undefined : config.model) };
  const check = providerConfig(main, config);
  if ('error' in check) {
    io.stderr.write(`orka: ${check.error}\n`);
    return 2;
  }
  const supervisorEnabled = args.supervisor !== false && (typeof args.supervisor === 'string' || config.supervisor?.enabled !== false);
  const supervisor: AgentChoice | undefined = !supervisorEnabled
    ? undefined
    : typeof args.supervisor === 'string'
      ? parseChoice(args.supervisor)
      : { provider: config.supervisor?.provider ?? main.provider, model: config.supervisor?.model ?? (config.supervisor?.provider ? undefined : main.model) };
  if (supervisor) {
    const sup = providerConfig(supervisor, config);
    if ('error' in sup) {
      io.stderr.write(`orka: ${t('Supervisor')}: ${sup.error}\n`);
      return 2;
    }
  }

  const print = args.print;
  const interactive = !!io.stdin.isTTY;
  const out = (text: string) => io.stdout.write(text);
  const info = print ? (text: string) => io.stderr.write(text) : out;
  const rl = interactive ? readline.createInterface({ input: io.stdin, output: io.stdout, terminal: true, historySize: 500 }) : undefined;
  const approver = new Approver(rl, info, s);
  const session = new Session(root, config, main, supervisor, args.mode ?? config.mode ?? 'balanced', approver);
  const renderer = new Renderer(out, info, print ? style(!!io.stderr.isTTY && !process.env.NO_COLOR) : s);
  session.orchestrator.on((event) => renderer.handle(event));
  const skillErrors = await session.loadSkills();
  for (const e of skillErrors) info(`${s.yellow('!')} ${e}\n`);

  let running = false;
  const runOnce = async (text: string, skills: Skill[] = []): Promise<RunEndReason> => {
    running = true;
    try {
      const reason = await session.run(text, skills);
      renderer.summary(reason, session.orchestrator.lastError);
      if (reason === 'error' && !print && USAGE_LIMIT.test(session.orchestrator.lastError ?? '')) {
        info(s.dim(`${t('The provider hit a usage limit. You can continue this task in {agent} for free.', { agent: 'Freebuff' })} (/freebuff)\n`));
      }
      return reason;
    } finally {
      running = false;
    }
  };

  let exitArmed = false;
  rl?.on('SIGINT', () => {
    if (approver.asking) {
      approver.cancel();
      session.orchestrator.stop();
    } else if (running) {
      session.orchestrator.stop();
    } else if (exitArmed) {
      rl.close();
    } else {
      exitArmed = true;
      io.stdout.write(`\n${s.dim(t('Press Ctrl+C again to exit.'))}\n`);
      rl.write(null, { ctrl: true, name: 'u' });
      rl.prompt(true);
    }
  });
  if (!rl) process.on('SIGINT', () => (running ? session.orchestrator.stop() : process.exit(130)));

  try {
    if (!print) {
      const label = `${main.provider}${main.model ? ` (${main.model})` : ''}`;
      out(`${s.bold(s.cyan('Orka'))} ${s.dim(VERSION)}  ·  ${label}  ·  ${session.permissions.getMode()}${supervisor ? `  ·  ${t('Supervisor')}: ${supervisor.provider}${supervisor.model ? ` (${supervisor.model})` : ''}` : ''}\n`);
      out(s.dim(`${root}\n${t('/help for commands · @file attaches · Ctrl+C stops')}\n`));
    }
    if (args.resume) {
      const task = await session.resume();
      info(task ? s.dim(`${t('Continuing')}: ${task.title}\n`) : s.dim(`${t('No earlier task in this folder.')}\n`));
    }
    if (print) {
      const reason = await runOnce(args.prompt!);
      return reason === 'error' ? 1 : reason === 'stopped' ? 130 : 0;
    }
    if (!rl) {
      // Piped input: every line is a request.
      const lines = readline.createInterface({ input: io.stdin });
      if (args.prompt) await runOnce(args.prompt);
      for await (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        if (text.startsWith('/') && !text.startsWith('//')) {
          const result = await slash(text, session, undefined, s);
          if (result === 'exit') break;
          if (result === 'handled') continue;
          if ('handoff' in result) await handOff(session, result.handoff, result.text, undefined, s);
          else await runOnce(result.run, result.skills);
          continue;
        }
        await runOnce(text);
      }
      return 0;
    }
    let pending = args.prompt;
    let closed = false;
    rl.on('close', () => {
      closed = true;
    });
    while (!closed) {
      const line = pending ?? (await nextLine(rl, `\n${s.cyan('›')} `));
      pending = undefined;
      if (line === undefined) break;
      exitArmed = false;
      const text = line.trim();
      if (!text) continue;
      if (text.startsWith('/') && !text.startsWith('//')) {
        const result = await slash(text, session, rl, s);
        if (result === 'exit') break;
        if (result === 'handled') continue;
        if ('handoff' in result) await handOff(session, result.handoff, result.text, rl, s);
        else await runOnce(result.run, result.skills);
        continue;
      }
      await runOnce(text);
    }
    return 0;
  } finally {
    await session.save();
    session.dispose();
    rl?.close();
  }
}

/** The next line typed at the prompt, or undefined when input closes (Ctrl+D / Ctrl+C twice). */
function nextLine(rl: readline.Interface, prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const onClose = () => resolve(undefined);
    rl.once('close', onClose);
    rl.question(prompt, (answer) => {
      rl.off('close', onClose);
      resolve(answer);
    });
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      io.stderr.write(`orka: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
