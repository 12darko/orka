import * as path from 'node:path';
import { t } from '../i18n';
import { AcpClient, type AcpLaunchSpec } from './AcpClient';

export interface AcpAgentPoolOptions {
  /** Stop a process after this long without a running prompt. Default 15 minutes. */
  idleTimeoutMs?: number;
  /** Processes kept at once. Default 4. */
  max?: number;
  /** Tests start their fake agent here. */
  create?: (spec: AcpLaunchSpec) => AcpClient;
}

interface Entry {
  client: AcpClient;
  /** Prompts running on it; a leased process is never stopped. */
  leases: number;
  lastUsed: number;
  timer?: NodeJS.Timeout;
}

const IDLE_TIMEOUT_MS = 15 * 60_000;
const MAX_PROCESSES = 4;

/**
 * Agent processes, kept running between prompts (starting one takes seconds) and shared by the
 * sessions of one agent in one folder. A prompt leases its process; an idle process stops after
 * the idle timeout, and the oldest idle one makes room when the cap is reached.
 */
export class AcpAgentPool {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: AcpAgentPoolOptions = {}) {}

  get size(): number {
    return this.entries.size;
  }

  /** A started agent for `spec`; give it back with release() when the prompt is over. */
  async acquire(spec: AcpLaunchSpec): Promise<AcpClient> {
    const key = poolKey(spec);
    let entry = this.entries.get(key);
    if (entry && !entry.client.alive) {
      this.drop(key, entry);
      entry = undefined;
    }
    if (!entry) {
      this.makeRoom();
      if (this.entries.size >= (this.options.max ?? MAX_PROCESSES)) {
        throw new Error(t('{n} agent processes are already working. Wait for one to finish or stop it, then try again.', { n: this.entries.size }));
      }
      const client = this.options.create ? this.options.create(spec) : new AcpClient(spec);
      const created: Entry = { client, leases: 0, lastUsed: Date.now() };
      client.onClose(() => {
        if (this.entries.get(key) === created) this.drop(key, created);
      });
      this.entries.set(key, created);
      entry = created;
    }
    entry.leases++;
    entry.lastUsed = Date.now();
    clearTimeout(entry.timer);
    try {
      await entry.client.start();
    } catch (error) {
      entry.leases--;
      this.drop(key, entry);
      throw error;
    }
    return entry.client;
  }

  /** The prompt is over; the process may idle out. */
  release(client: AcpClient): void {
    for (const [key, entry] of this.entries) {
      if (entry.client !== client) continue;
      entry.leases = Math.max(0, entry.leases - 1);
      entry.lastUsed = Date.now();
      if (entry.leases === 0) {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.drop(key, entry), this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
        entry.timer.unref?.();
      }
      return;
    }
  }

  /** Stop every agent process (the app closes, the folder changes, agents were turned off). */
  dispose(): void {
    for (const [key, entry] of [...this.entries]) this.drop(key, entry);
  }

  /** Stop idle processes, oldest first, until one more fits under the cap. */
  private makeRoom(): void {
    const max = this.options.max ?? MAX_PROCESSES;
    const idle = [...this.entries].filter(([, e]) => e.leases === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (this.entries.size >= max && idle.length) {
      const [key, entry] = idle.shift()!;
      this.drop(key, entry);
    }
  }

  private drop(key: string, entry: Entry): void {
    clearTimeout(entry.timer);
    if (this.entries.get(key) === entry) this.entries.delete(key);
    entry.client.close();
  }
}

/**
 * A third-party agent as Orka's main agent (OrchestratorOptions.getExternalAgent): which agent,
 * and where its process comes from for each request.
 */
export interface ExternalAgentRuntime {
  /** Catalog id ("gemini", "custom:my-agent"). */
  readonly id: string;
  readonly label: string;
  /** The vendor's own login command, for the "not logged in" notice. */
  readonly loginCommand?: string;
  /** A started agent for this request. */
  acquire(): Promise<AcpClient>;
  /** The request is over. */
  release(client: AcpClient): void;
}

/** The runtime for one agent launched from a shared pool. */
export function pooledAgent(pool: AcpAgentPool, spec: AcpLaunchSpec): ExternalAgentRuntime {
  return {
    id: spec.agentId,
    label: spec.label,
    loginCommand: spec.loginCommand,
    acquire: () => pool.acquire(spec),
    release: (client) => pool.release(client),
  };
}

/** One process per agent and folder; a changed command line (another path, other arguments) is another process. */
function poolKey(spec: AcpLaunchSpec): string {
  return JSON.stringify([spec.agentId, path.resolve(spec.cwd), spec.command, spec.args]);
}
