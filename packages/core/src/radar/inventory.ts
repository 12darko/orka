import { promises as fs } from 'node:fs';
import { t } from '../i18n';

/** One thing Orka can do, as the radar compares other tools against it. */
export interface InventoryFeature {
  /** Lowercase letters, digits, dots and dashes ("checkpoints.rewind"). */
  id: string;
  title: string;
  /** A short area slug, usually one of RADAR_TAGS. */
  area: string;
  summary: string;
}

export interface FeatureInventory {
  features: InventoryFeature[];
}

const MAX_FEATURES = 400;
const MAX_FILE_BYTES = 1_000_000;

const feature = (id: string, area: string, title: string, summary: string): InventoryFeature => ({ id, area, title, summary });

/** Orka's own features, so the radar works without a docs/features.json. Keep it in step with the README. */
export const BUILTIN_INVENTORY: FeatureInventory = {
  features: [
    feature('agents.main-loop', 'agents', 'Main agent loop', 'One agent plans, edits files, runs commands, builds and tests, then reports how it verified the change.'),
    feature('agents.subagents', 'subagents', 'Sub-agents', 'explore and review sub-agents (read-only) and worker sub-agents, each on its own provider and model, run in parallel.'),
    feature('agents.parallel-workers', 'subagents', 'Parallel workers', 'Workers edit side by side in private copies of the project; their changes are merged three-way and overlaps reported.'),
    feature('agents.supervisor', 'review', 'Supervisor', 'A second model watches the main agent at key moments, corrects it and checks the result before it finishes.'),
    feature('agents.review-command', 'review', 'Code review command', '/review runs a read-only review of the current changes.'),
    feature('agents.handoff', 'agents', 'Hand-off to other agents', 'Hands a task with a summary to an external terminal agent and shows the files it changed afterwards.'),
    feature('planning.plan', 'planning', 'Plans', 'The agent proposes a plan, tracks progress per step and revises it; /plan asks for a plan first.'),
    feature('permissions.modes', 'permissions', 'Permission modes', 'Ask, Balanced and Autonomous modes; risky commands and writes outside the workspace always ask.'),
    feature('permissions.overrides', 'permissions', 'Per-category approvals', 'File edits, terminal, git, deletes and web access can each be set to ask or allow.'),
    feature('permissions.secrets-guard', 'permissions', 'Secrets guard', 'After an agent reads a file that may hold secrets, web access and MCP tools ask for approval for the rest of the task.'),
    feature('changes.panel', 'diff-review', 'Changes panel', 'Every changed file with a diff; keep or revert per file, per hunk or all at once.'),
    feature('changes.inline-review', 'diff-review', 'Inline review', 'Added and removed lines are marked in the editor with Keep and Revert actions (VS Code).'),
    feature('checkpoints.command-snapshots', 'checkpoints', 'Command snapshots', 'Files changed by terminal commands are snapshotted in a private git directory and can be reverted.'),
    feature('checkpoints.rewind', 'checkpoints', 'Go back (rewind)', 'Return to before any message: the conversation and the files the agents changed since are restored.'),
    feature('hooks.lifecycle', 'hooks', 'Hooks', 'afterEdit runs formatters or linters after each edit; beforeFinish runs checks before the agent may finish.'),
    feature('memory.project', 'memory', 'Project memory', 'A .project-ai folder with context, architecture, decisions and conventions read at the start of every task.'),
    feature('memory.lessons', 'memory', 'Learned lessons', 'After a task, lasting project lessons are kept in .project-ai/lessons.md for later tasks.'),
    feature('skills.playbooks', 'skills', 'Skills', 'Built-in and user skills (Markdown playbooks) the agent loads when a task fits, or that the user invokes with /name.'),
    feature('mcp.client', 'mcp', 'MCP servers', 'stdio and Streamable HTTP MCP servers, a project .mcp.json, import from Claude Code, per-server on/off.'),
    feature('browser.headless', 'browser', 'Browser tool', 'Headless Chrome or Edge: screenshots, clicks, typing, page text and console errors.'),
    feature('web.fetch', 'web', 'Web fetch', 'Reads web pages and documentation as text; never reaches cloud metadata or link-local addresses.'),
    feature('terminal.commands', 'terminal', 'Terminal commands', 'Runs build, test and project commands with risk classification.'),
    feature('terminal.processes', 'terminal', 'Background processes', 'Starts dev servers and watchers in the background and waits until they are ready.'),
    feature('context.project-scan', 'context', 'Project scan and editor context', 'Detects the project type and commands; each message carries the active file, selection, errors and git status.'),
    feature('context.outline', 'context', 'Code outline', 'Lists classes and methods with line numbers so the agent reads only what it needs.'),
    feature('context.compaction', 'context', 'Compaction', 'Long conversations are compacted into a handoff note with an exact record of requests, plan and changes.'),
    feature('models.providers', 'models', 'Many providers', 'Claude, OpenAI, Gemini and any OpenAI-compatible endpoint; model lists come from the provider.'),
    feature('models.per-role', 'models', 'Model per role', 'Main agent, Supervisor and each sub-agent can use a different provider and model.'),
    feature('models.fallback', 'models', 'Fallback provider', 'When a provider hits a limit or fails, the request continues on a fallback with the same conversation.'),
    feature('models.light-model', 'models', 'Light model for questions', 'Simple questions go to a lighter model; work moves to the main model with the same conversation.'),
    feature('usage.tokens', 'usage', 'Usage and budget', 'Tokens and estimated cost per role, user prices, and a token budget that pauses a request.'),
    feature('sessions.history', 'sessions', 'Task history', 'Every task is saved and can be continued exactly where it stopped, also across the CLI and the desktop app.'),
    feature('multimodal.images', 'multimodal', 'Images in messages', 'Paste or drop images; large ones are downscaled before sending.'),
    feature('git.tools', 'git', 'Git tools', 'git status, diff, log and branch for the agent; commits and pushes ask.'),
    feature('cli.orka', 'cli', 'Orka CLI', 'Interactive terminal sessions, one-shot -p mode for scripts, continue the last task, approvals in the terminal.'),
    feature('ide.vscode', 'ide-integration', 'VS Code extension', 'Chat panel, Fix with Orka quick fix, explain or ask about a selection.'),
    feature('ui.desktop', 'ui-layout', 'Desktop app', 'Session list, centered conversation, plan and changes panel, own light and dark theme.'),
    feature('ui.languages', 'ui-layout', 'English and Turkish UI', 'The whole interface is available in English and Turkish.'),
  ],
};

export interface InventoryValidation {
  inventory?: FeatureInventory;
  errors: string[];
}

const plain = (value: unknown, max: number): value is string =>
  // eslint-disable-next-line no-control-regex
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value);

/** Check a docs/features.json-style object: {features:[{id, title, area, summary}]}. */
export function validateInventory(value: unknown): InventoryValidation {
  const list = value && typeof value === 'object' ? (value as { features?: unknown }).features : undefined;
  if (!Array.isArray(list)) return { errors: [t('The feature list must be an object with a "features" list.')] };
  if (list.length === 0 || list.length > MAX_FEATURES) return { errors: [t('The feature list must have 1 to {n} features.', { n: MAX_FEATURES })] };
  const errors: string[] = [];
  const ids = new Set<string>();
  const features: InventoryFeature[] = [];
  list.forEach((raw, i) => {
    const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof f.id === 'string' && /^[a-z0-9][a-z0-9.-]{1,63}$/.test(f.id) ? f.id : undefined;
    const label = id ?? `#${i + 1}`;
    if (!id) errors.push(t('Feature {id}: the id must be 2-64 lowercase letters, digits, dots or dashes.', { id: label }));
    else if (ids.has(id)) errors.push(t('Feature {id}: the id is used twice.', { id }));
    else if (!plain(f.title, 80) || !plain(f.summary, 300) || typeof f.area !== 'string' || !/^[a-z0-9-]{1,32}$/.test(f.area))
      errors.push(t('Feature {id}: title (up to 80 characters), area (a short slug) and summary (up to 300 characters) are required.', { id }));
    else {
      ids.add(id);
      features.push({ id, title: f.title.trim(), area: f.area, summary: f.summary.trim() });
    }
  });
  return errors.length ? { errors } : { inventory: { features }, errors };
}

/** Read and check a feature list file; throws with a message for the user when it cannot be used. */
export async function loadFeatureInventory(file: string): Promise<FeatureInventory> {
  let text: string;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_FILE_BYTES) throw new Error(t('{file} is larger than 1 MB.', { file }));
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new Error(t('Could not read {file}: {error}', { file, error: error instanceof Error ? error.message : String(error) }));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(t('{file} is not valid JSON: {error}', { file, error: error instanceof Error ? error.message : String(error) }));
  }
  const checked = validateInventory(value);
  if (!checked.inventory) throw new Error(t('{file} cannot be used: {errors}', { file, errors: checked.errors.slice(0, 5).join(' ') }));
  return checked.inventory;
}
