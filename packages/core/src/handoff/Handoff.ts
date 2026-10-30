import * as path from 'node:path';
import type { ChangeTracker } from '../changes/ChangeTracker';
import type { CommandChange, ShadowGit } from '../changes/ShadowGit';
import { formatPlan, type Plan } from '../planning/Plan';
import type { ChatMessage } from '../types';

export { findExecutable } from '../host/commands';

/**
 * A coding agent that runs on its own in a terminal (no API to call it from Orka). Orka hands a
 * task over to it and afterwards picks up the files it changed, so they can be reviewed and
 * reverted like Orka's own changes.
 */
export interface ExternalAgent {
  id: string;
  label: string;
  /** Executable to look up on PATH. */
  command: string;
  url: string;
  /** Shown to the user (never run without them asking). */
  installCommand: string;
  /** One line on what it is, for pickers. */
  description: string;
}

export const EXTERNAL_AGENTS: readonly ExternalAgent[] = [
  {
    id: 'freebuff',
    label: 'Freebuff',
    command: 'freebuff',
    url: 'https://freebuff.com',
    installCommand: 'npm install -g freebuff',
    description: 'Free, ad-supported terminal coding agent (open models, daily allowance).',
  },
];

export function externalAgent(id: string): ExternalAgent | undefined {
  return EXTERNAL_AGENTS.find((a) => a.id === id);
}

const MAX_REQUEST_CHARS = 1500;

/**
 * The user's own requests in a conversation. A request message is "<context>…</context>", the
 * request, then attached files and skills as tags; tool results, supervisor corrections and other
 * notes the orchestrator adds have no context block and are skipped.
 */
export function userRequests(messages: readonly ChatMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = typeof m.content === 'string' ? m.content : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    const match = /^<context>[\s\S]*?<\/context>\n\n([\s\S]*)$/.exec(text);
    if (!match) continue;
    const request = match[1].split(/\n\n<(?:attached_file|skill)\b/)[0].trim();
    if (request) out.push(request);
  }
  return out;
}

/** A short task summary for another agent: what the user asked, the plan, what changed so far. */
export function handoffBrief(input: { requests: readonly string[]; plan?: Plan; changedFiles?: readonly string[]; note?: string }): string {
  const lines: string[] = [];
  const requests = input.requests.slice(-4).map((r) => (r.length > MAX_REQUEST_CHARS ? `${r.slice(0, MAX_REQUEST_CHARS)}…` : r));
  if (input.note?.trim()) lines.push(input.note.trim(), '');
  if (requests.length) {
    lines.push(requests.length === 1 ? 'Task:' : 'Task (the user\'s requests, oldest first):');
    for (const r of requests) lines.push(requests.length === 1 ? r : `- ${r}`);
  }
  if (input.plan?.steps.length) lines.push('', 'Plan so far ([x] done, [>] in progress):', formatPlan(input.plan));
  if (input.changedFiles?.length) lines.push('', 'Files already changed for this task:', ...input.changedFiles.slice(0, 30).map((f) => `- ${f}`));
  if (!lines.length) return '';
  lines.push('', 'Continue from here. Check the current state of the files before changing them.');
  return lines.join('\n');
}

/**
 * Files changed since a snapshot, recorded in the change tracker with their earlier content so
 * they can be diffed and reverted. Files the tracker already follows keep their older original and
 * are only reported with `includeTracked`.
 */
export async function recordChangesSince(
  snapshots: ShadowGit,
  before: string,
  changes: ChangeTracker,
  root: string,
  includeTracked = false,
): Promise<CommandChange[]> {
  const changed = await snapshots.changedSince(before);
  const recorded: CommandChange[] = [];
  for (const change of changed) {
    const abs = path.join(root, change.path);
    if (changes.isTracked(abs)) {
      if (includeTracked) recorded.push(change);
      continue;
    }
    const original = change.status === 'added' ? null : await snapshots.fileAt(before, change.path);
    if (original === undefined) continue; // binary: not revertible as text
    changes.recordOriginal(abs, original);
    recorded.push(change);
  }
  if (recorded.length) changes.notify();
  return recorded;
}

/**
 * One hand-off: a snapshot when it starts, and the files changed since when it ends. An ACP agent
 * (acp/) uses the same pair around each prompt, so it only needs the agent's id and label.
 */
export class Handoff<A extends { id: string; label: string } = ExternalAgent> {
  private baseline?: string;

  constructor(
    readonly agent: A,
    private readonly root: string,
    private readonly snapshots: ShadowGit | undefined,
    private readonly changes: ChangeTracker,
  ) {}

  get active(): boolean {
    return !!this.baseline;
  }

  /** Why changes cannot be picked up afterwards (no git, snapshots off), if so. */
  get untrackedReason(): string | undefined {
    if (!this.snapshots) return 'change tracking for commands is off';
    return this.snapshots.disabledReason;
  }

  /** Snapshot the workspace; false when changes cannot be tracked. */
  async begin(): Promise<boolean> {
    this.baseline = this.snapshots ? await this.snapshots.snapshot() : undefined;
    return !!this.baseline;
  }

  /** Record what changed since begin() (and start over from now, for a hand-off that goes on). */
  async collect(continueTracking = false): Promise<CommandChange[]> {
    const before = this.baseline;
    if (!before || !this.snapshots) return [];
    let changed: CommandChange[] = [];
    try {
      changed = await recordChangesSince(this.snapshots, before, this.changes, this.root, true);
    } finally {
      this.baseline = continueTracking ? await this.snapshots.snapshot().catch(() => undefined) : undefined;
    }
    return changed;
  }
}
