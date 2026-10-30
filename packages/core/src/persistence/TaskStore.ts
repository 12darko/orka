import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChangeCheckpoint } from '../changes/ChangeTracker';
import type { AgentUsage } from '../orchestrator/events';
import type { Plan } from '../planning/Plan';
import type { ChatMessage, Usage } from '../types';

/** Everything needed to show a past task again and continue it. */
export interface TaskSnapshot {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** The model conversation, including provider-native blocks, exactly as sent. */
  messages: ChatMessage[];
  systemPrompt?: string;
  /** Sub-agents that were offered in this task (its tool list is rebuilt from them). */
  subagentProfiles: string[];
  plan?: Plan;
  usageByAgent: AgentUsage[];
  /** Skills that were offered in this task (the load_skill tool is rebuilt from them). */
  skills?: string[];
  /** Pre-change contents of files the agent changed and that were not accepted yet. */
  checkpoint?: ChangeCheckpoint[];
  /** Front-end view of the task (e.g. a SessionView) for replaying the chat. */
  view?: unknown;
}

export interface TaskSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Number of user requests in the task. */
  requests: number;
  /** Model of the main agent, if known. */
  model?: string;
  usage?: Usage;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function newTaskId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Task history as JSON files in one folder (one file per task plus a small index), so the
 * VS Code extension, the desktop app and a CLI can all read the same history.
 */
export class FileTaskStore {
  /** Saves and deletes run one at a time: each one rewrites the shared index. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async list(): Promise<TaskSummary[]> {
    const index = await this.readIndex();
    return Object.values(index).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string): Promise<TaskSnapshot | undefined> {
    if (!ID.test(id)) return undefined;
    try {
      const snapshot = JSON.parse(await fs.readFile(this.file(id), 'utf8')) as TaskSnapshot;
      return snapshot.version === 1 && snapshot.id === id ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  async save(snapshot: TaskSnapshot): Promise<void> {
    if (!ID.test(snapshot.id)) throw new Error(`Invalid task id: ${snapshot.id}`);
    return this.serial(() => this.write(snapshot));
  }

  async delete(id: string): Promise<void> {
    if (!ID.test(id)) return;
    return this.serial(async () => {
      await fs.rm(this.file(id), { force: true });
      const index = await this.readIndex();
      delete index[id];
      await writeAtomic(this.indexFile, JSON.stringify(index));
    });
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(snapshot: TaskSnapshot): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await writeAtomic(this.file(snapshot.id), JSON.stringify(snapshot));
    const index = await this.readIndex();
    const main = snapshot.usageByAgent.find((u) => u.agent === 'main');
    const total = snapshot.usageByAgent.reduce<Usage | undefined>(
      (sum, u) =>
        sum
          ? {
              inputTokens: sum.inputTokens + u.usage.inputTokens,
              outputTokens: sum.outputTokens + u.usage.outputTokens,
              cacheReadTokens: sum.cacheReadTokens + u.usage.cacheReadTokens,
              cacheWriteTokens: sum.cacheWriteTokens + u.usage.cacheWriteTokens,
            }
          : { ...u.usage },
      undefined,
    );
    index[snapshot.id] = {
      id: snapshot.id,
      title: snapshot.title,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      requests: countRequests(snapshot.messages),
      model: main?.model,
      usage: total,
    };
    await writeAtomic(this.indexFile, JSON.stringify(index));
  }

  private get indexFile(): string {
    return path.join(this.dir, 'index.json');
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async readIndex(): Promise<Record<string, TaskSummary>> {
    try {
      return JSON.parse(await fs.readFile(this.indexFile, 'utf8'));
    } catch {
      return {};
    }
  }
}

/** A user turn that starts a request (not tool results or orchestrator notes). */
function countRequests(messages: ChatMessage[]): number {
  return messages.filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text.startsWith('<context>'))).length;
}

let tempCount = 0;

async function writeAtomic(file: string, data: string): Promise<void> {
  // Unique per write: two stores on the same folder in one process never share a temp file.
  const temp = `${file}.${process.pid}.${++tempCount}.tmp`;
  await fs.writeFile(temp, data, 'utf8');
  await fs.rename(temp, file);
}
