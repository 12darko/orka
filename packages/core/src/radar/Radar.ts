import { t } from '../i18n';
import type { AIProvider } from '../providers/AIProvider';
import { HostPacer } from './fetch';
import { BUILTIN_INVENTORY, type FeatureInventory } from './inventory';
import { analyzeEntries, pollSources, RADAR_REFUSED_PROVIDERS, type RadarAnalyzeOptions, type RadarPollResult } from './pipeline';
import { defaultSources, validateSources } from './sources';
import { loadRadarState, pruneSources, QUARANTINE_CAP, queue, type RadarPollStatus, saveRadarState } from './state';
import type { RadarReport, RadarSource } from './types';

export interface RadarOptions {
  /** The JSON state file (validators, seen ids, pending entries). Created on first use. */
  statePath: string;
  /** Default: the "AI coding tools" preset. Checked with validateSources; invalid ones are left out (see `sourceErrors`). */
  sources?: readonly unknown[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Shared spacing between requests to one host; one per radar by default. */
  pacer?: HostPacer;
  /** Per request, default 30 s. */
  timeoutMs?: number;
}

export interface RadarSourceStatus {
  id: string;
  vendor: string;
  product: string;
  enabled: boolean;
  lastPolledAt?: string;
  lastStatus?: RadarPollStatus;
  lastError?: string;
  /** Set once the first poll succeeded. */
  baselineAt?: string;
}

export interface RadarStatus {
  /** Entries waiting for analysis: a non-zero count means there is something to wake up for. */
  pending: number;
  quarantined: number;
  sources: RadarSourceStatus[];
}

/**
 * The radar's API for the apps. `poll()` checks the feeds (no model calls) and queues new
 * entries; `analyze()` wakes up only when something is queued and returns a report. State is a
 * JSON file the caller chooses; reports are returned and kept by the caller (mergeReports joins
 * them for a panel). Safe to call from timers: calls on one instance are serialized.
 */
export class Radar {
  /** The valid sources, normalized. */
  readonly sources: readonly RadarSource[];
  /** Why sources were left out (for the user, translated). */
  readonly sourceErrors: readonly string[];
  private readonly pacer: HostPacer;
  private lock: Promise<unknown> = Promise.resolve();
  private analyzing = false;

  constructor(private readonly options: RadarOptions) {
    // Checked here too: the patterns run on feed text and the hosts decide what gets fetched.
    const checked = validateSources(options.sources ?? defaultSources());
    this.sources = checked.sources;
    this.sourceErrors = checked.errors;
    this.pacer = options.pacer ?? new HostPacer();
  }

  /** Check every source that is due (or all with `force`) and queue new entries. Never calls a model. */
  poll(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<RadarPollResult> {
    return this.exclusive(async () => {
      const state = await loadRadarState(this.options.statePath);
      pruneSources(
        state,
        this.sources.map((s) => s.id),
      );
      const result = await pollSources(this.sources, state, {
        fetchImpl: this.options.fetchImpl,
        pacer: this.pacer,
        signal: opts.signal,
        timeoutMs: this.options.timeoutMs,
        force: opts.force,
        now: this.now(),
      });
      await saveRadarState(this.options.statePath, state);
      return result;
    });
  }

  /**
   * Analyze queued entries with `provider` (the user's own API provider; never the Claude Code
   * provider). Returns undefined without any model call when nothing is queued. Entries the run
   * did not get to stay queued; entries the model failed on twice are quarantined.
   */
  async analyze(provider: AIProvider, opts: RadarAnalyzeOptions & { inventory?: FeatureInventory } = {}): Promise<RadarReport | undefined> {
    if (RADAR_REFUSED_PROVIDERS.includes(provider.id)) throw new Error(t('The radar needs an API provider; the Claude Code provider cannot run it.'));
    if (this.analyzing) throw new Error(t('The radar is already analyzing new entries.'));
    this.analyzing = true;
    try {
      const { pending } = await this.exclusive(() => loadRadarState(this.options.statePath));
      if (pending.length === 0) return undefined;
      const result = await analyzeEntries(pending, provider, opts.inventory ?? BUILTIN_INVENTORY, { ...opts, sources: this.sources, now: opts.now ?? this.options.now });
      await this.exclusive(async () => {
        // Read again: a poll may have queued more entries meanwhile.
        const state = await loadRadarState(this.options.statePath);
        const done = new Set(result.processed);
        state.pending = state.pending.filter((e) => !done.has(e.id));
        const at = this.now().toISOString();
        state.quarantine.push(...result.quarantined.map((q) => ({ ...q, at })));
        if (state.quarantine.length > QUARANTINE_CAP) state.quarantine.splice(0, state.quarantine.length - QUARANTINE_CAP);
        await saveRadarState(this.options.statePath, state);
      });
      return result.report;
    } finally {
      this.analyzing = false;
    }
  }

  /** Per-source poll state and the queue sizes, for a status line. */
  status(): Promise<RadarStatus> {
    return this.exclusive(async () => {
      const state = await loadRadarState(this.options.statePath);
      return {
        pending: state.pending.length,
        quarantined: state.quarantine.length,
        sources: this.sources.map((source) => {
          const s = state.sources[source.id]?.url === source.url ? state.sources[source.id] : undefined;
          return {
            id: source.id,
            vendor: source.vendor,
            product: source.product,
            enabled: source.enabled,
            ...(s?.lastPolledAt ? { lastPolledAt: s.lastPolledAt } : {}),
            ...(s?.lastStatus ? { lastStatus: s.lastStatus } : {}),
            ...(s?.lastError ? { lastError: s.lastError } : {}),
            ...(s?.baselineAt ? { baselineAt: s.baselineAt } : {}),
          };
        }),
      };
    });
  }

  /** Put quarantined entries back in the queue (after a provider or model change). Returns how many. */
  retryQuarantined(): Promise<number> {
    return this.exclusive(async () => {
      const state = await loadRadarState(this.options.statePath);
      const entries = state.quarantine.map((q) => q.entry);
      state.quarantine = [];
      const added = queue(state, entries);
      await saveRadarState(this.options.statePath, state);
      return added.length;
    });
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lock.then(work, work);
    this.lock = next.catch(() => {});
    return next;
  }
}
