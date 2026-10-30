import {
  type AIProvider,
  getLocale,
  type HostPacer,
  mergeReports,
  proposalSpec,
  Radar,
  type RadarCluster,
  type RadarItem,
  radarLinkTarget,
  type RadarReport,
  type RadarStage,
  type RadarStatus,
  t,
  validateReport,
} from '@orka/core';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RadarClusterView, RadarItemView, RadarReportView, RadarView, ToWebview } from './protocol';
import type { AppSettings } from './settings';

/** The first poll after the app starts waits this long, so the window opens first. */
const START_DELAY_MS = 30_000;
/** Then Radar looks every hour; each source is fetched only as often as its own interval allows. */
const POLL_INTERVAL_MS = 60 * 60 * 1000;
/** One analysis reads at most this many entries with at most this many model calls (the core's caps, shown in the panel). */
const MAX_ENTRIES = 40;
const MAX_CALLS = 100;
/** Changes outside the clusters that the panel lists. */
const MAX_OTHERS = 60;
/** A saved report larger than this is not read. */
const MAX_REPORT_BYTES = 16_000_000;

export interface RadarTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const NODE_TIMERS: RadarTimers = {
  set: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What tests replace: the network, the clock, the timers and the feeds. */
export interface RadarHooks {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timers?: RadarTimers;
  /** Default: the core's "AI coding tools" preset. */
  sources?: readonly unknown[];
  pacer?: HostPacer;
}

export type RadarModel = { provider: string; model: string; label: string; inherited: boolean } | { problem: string };

/** What Radar needs from the controller it runs in. */
export interface RadarHost {
  post(message: ToWebview): void;
  /** The model an analysis would run on, or why there is none. */
  model(): RadarModel;
  createProvider(ref: string, model: string): AIProvider;
  /** A new task in the current folder with `text` in the message box, never sent. */
  startSession(text: string): Promise<void>;
  openExternal(url: string): Promise<boolean>;
}

interface Analysis {
  abort: AbortController;
  stage: RadarStage;
  done: number;
  total: number;
  calls: number;
}

/**
 * The desktop app's Radar. While the user has it on, it polls the public release notes of other AI
 * coding tools (never a model call); when they click Analyze (or with radar.autoAnalyze, after a
 * poll found something), it analyzes the new entries with the user's own provider and keeps one
 * merged report. Its files live in <orka home>/radar: the engine's state.json and report.json.
 */
export class RadarController {
  private readonly radar: Radar;
  private readonly timers: RadarTimers;
  private readonly reportFile: string;
  private timer?: unknown;
  private poller?: AbortController;
  private analysis?: Analysis;
  private report?: RadarReport;
  private status: RadarStatus = { pending: 0, quarantined: 0, sources: [] };
  /** A problem to show in the panel until the next poll or analysis. */
  private error?: string;
  private disposed = false;

  constructor(
    private readonly dir: string,
    private settings: AppSettings['radar'],
    private readonly host: RadarHost,
    private readonly hooks: RadarHooks = {},
  ) {
    // Nothing is read or fetched here: the engine reads its state file when it is used.
    this.radar = new Radar({ statePath: path.join(dir, 'state.json'), sources: hooks.sources, fetchImpl: hooks.fetchImpl, now: hooks.now, pacer: hooks.pacer });
    this.reportFile = path.join(dir, 'report.json');
    this.timers = hooks.timers ?? NODE_TIMERS;
  }

  /** Read the saved report and state (local files only), and plan the first poll when Radar is on. */
  async initialize(): Promise<void> {
    this.report = await this.readReport();
    this.status = await this.radar.status().catch(() => this.status);
    this.postAll();
    if (this.settings.enabled) this.schedule(START_DELAY_MS);
  }

  /** The settings were read again: turning Radar on checks the feeds right away, turning it off stops everything. */
  apply(settings: AppSettings['radar']): void {
    const was = this.settings.enabled;
    this.settings = settings;
    if (settings.enabled && !was) this.schedule(0);
    else if (!settings.enabled && was) this.stop();
    this.postState();
  }

  postAll(): void {
    this.postState();
    this.postReport();
  }

  postState(): void {
    if (!this.disposed) this.host.post({ type: 'radar', radar: this.view() });
  }

  private postReport(): void {
    if (!this.disposed) this.host.post({ type: 'radarReport', report: this.reportView() });
  }

  // ---------------------------------------------------------------- polling (no model calls)

  private schedule(ms: number): void {
    this.clearTimer();
    if (!this.settings.enabled || this.disposed) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.poll();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  /** Check the sources that are due (each one keeps its own minimum interval) and queue new entries. */
  async poll(): Promise<void> {
    if (!this.settings.enabled || this.poller || this.disposed) return;
    const abort = new AbortController();
    this.poller = abort;
    this.error = undefined;
    this.postState();
    let found = 0;
    try {
      found = (await this.radar.poll({ signal: abort.signal })).newEntries.length;
    } catch (error) {
      if (!abort.signal.aborted) this.error = t('Radar could not check the feeds: {error}', { error: messageOf(error) });
    } finally {
      if (this.poller === abort) this.poller = undefined;
    }
    await this.refresh();
    // Turned off meanwhile: nothing more is planned.
    if (abort.signal.aborted || !this.settings.enabled || this.disposed) return;
    this.schedule(POLL_INTERVAL_MS);
    if (found > 0 && this.settings.autoAnalyze && !('problem' in this.host.model())) void this.analyze();
  }

  /** Turned off: no timer, and whatever runs is stopped. */
  private stop(): void {
    this.clearTimer();
    this.poller?.abort();
    this.analysis?.abort.abort();
  }

  private async refresh(): Promise<void> {
    this.status = await this.radar.status().catch(() => this.status);
    this.postState();
  }

  // ---------------------------------------------------------------- analysis (model calls, on request)

  /** Analyze what is waiting with the model the panel shows; one analysis at a time. */
  async analyze(): Promise<void> {
    if (!this.settings.enabled || this.analysis || this.disposed) return;
    const choice = this.host.model();
    if ('problem' in choice) {
      this.error = choice.problem;
      this.postState();
      return;
    }
    let provider: AIProvider;
    try {
      provider = this.host.createProvider(choice.provider, choice.model);
    } catch (error) {
      this.error = messageOf(error);
      this.postState();
      return;
    }
    const run: Analysis = { abort: new AbortController(), stage: 'summarize', done: 0, total: 0, calls: 0 };
    this.analysis = run;
    this.error = undefined;
    this.postState();
    // Counts the calls as they go out, for the panel; the report's count is the final one.
    const counted: AIProvider = {
      id: provider.id,
      label: provider.label,
      model: provider.model,
      chat: (request, onEvent) => {
        run.calls++;
        this.postState();
        return provider.chat(request, onEvent);
      },
    };
    try {
      const report = await this.radar.analyze(counted, {
        previous: this.report,
        maxEntries: MAX_ENTRIES,
        maxCalls: MAX_CALLS,
        signal: run.abort.signal,
        language: getLocale(),
        onProgress: (p) => {
          Object.assign(run, { stage: p.stage, done: p.done, total: p.total });
          this.postState();
        },
      });
      if (report) {
        this.report = mergeReports(this.report, report);
        await this.saveReport();
        if (report.stats.stopped === 'error') this.error = t('The analysis stopped: {error}', { error: report.stats.error ?? '?' });
        this.postReport();
      }
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      provider.dispose?.();
      this.analysis = undefined;
      await this.refresh();
    }
  }

  stopAnalysis(): void {
    this.analysis?.abort.abort();
  }

  /** Put the entries the model could not read back in the queue (after a provider or model change). */
  async retry(): Promise<void> {
    await this.radar.retryQuarantined();
    await this.refresh();
  }

  /**
   * The text for a session that implements a proposal: the validated spec of the cluster in the
   * report, never anything from the page or the release notes.
   */
  async startSession(clusterKey: string): Promise<void> {
    const cluster = this.report?.clusters.find((c) => c.key === clusterKey);
    const spec = cluster?.decision ? proposalSpec(cluster.decision, cluster) : undefined;
    if (spec) await this.host.startSession(spec);
  }

  /** Open a release note: only an https link that is in the report, checked the way the report renderer checks it. */
  async openLink(url: string): Promise<void> {
    const target = radarLinkTarget(url);
    if (!target || !this.report?.items.some((i) => radarLinkTarget(i.url) === target)) return;
    await this.host.openExternal(target);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  // ---------------------------------------------------------------- the report file

  /** The saved report, checked field by field; a file that fails the checks is moved aside and never used. */
  private async readReport(): Promise<RadarReport | undefined> {
    let raw: string;
    try {
      if ((await fs.stat(this.reportFile)).size > MAX_REPORT_BYTES) throw new Error('too large');
      raw = await fs.readFile(this.reportFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      raw = '';
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    const { report } = validateReport(value);
    if (report) return report;
    const aside = path.join(this.dir, `report.broken-${Date.now()}.json`);
    await fs.rename(this.reportFile, aside).catch(() => undefined);
    this.error = t('The saved Radar report could not be read and was set aside ({file}).', { file: path.basename(aside) });
    return undefined;
  }

  private async saveReport(): Promise<void> {
    if (!this.report) return;
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.reportFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.report)}\n`, 'utf8');
    // Windows refuses to replace a file a scanner has open for a moment: try a few times.
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.rename(tmp, this.reportFile);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 8 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
  }

  // ---------------------------------------------------------------- views

  private view(): RadarView {
    const enabled = this.radar.sources.filter((s) => s.enabled);
    const polled = new Map(this.status.sources.map((s) => [s.id, s]));
    const hosts = new Map<string, string[]>();
    for (const source of enabled) {
      for (const host of source.allowHosts) hosts.set(host, [...new Set([...(hosts.get(host) ?? []), source.product])]);
    }
    const last = this.status.sources.map((s) => s.lastPolledAt ?? '').sort().at(-1);
    const model = this.host.model();
    const run = this.analysis;
    return {
      enabled: this.settings.enabled,
      autoAnalyze: this.settings.autoAnalyze,
      hosts: [...hosts].map(([host, products]) => ({ host, products })),
      sources: enabled.map((s) => {
        const state = polled.get(s.id);
        return {
          id: s.id,
          vendor: s.vendor,
          product: s.product,
          host: new URL(s.url).hostname,
          ...(state?.lastPolledAt ? { lastPolledAt: state.lastPolledAt } : {}),
          ...(state?.lastStatus ? { lastStatus: state.lastStatus } : {}),
          ...(state?.lastError ? { lastError: state.lastError } : {}),
        };
      }),
      sourceErrors: [...this.radar.sourceErrors],
      polling: !!this.poller,
      ...(last ? { lastPollAt: last } : {}),
      pending: this.status.pending,
      quarantined: this.status.quarantined,
      choice: { provider: this.settings.provider, model: this.settings.model },
      maxCalls: MAX_CALLS,
      ...('problem' in model ? { modelProblem: model.problem } : { model }),
      ...(run ? { analysis: { stage: run.stage, done: run.done, total: run.total, calls: run.calls, maxCalls: MAX_CALLS } } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private reportView(): RadarReportView | undefined {
    const report = this.report;
    if (!report) return undefined;
    const items = new Map(report.items.map((i) => [i.id, i]));
    const clustered = new Set(report.clusters.flatMap((c) => c.itemIds));
    const clusters: RadarClusterView[] = [...report.clusters]
      .sort((a, b) => rank(a) - rank(b) || b.relevance - a.relevance)
      .map((c) => ({
        key: c.key,
        title: c.title,
        vendors: c.vendors,
        tags: c.tags,
        items: c.itemIds.flatMap((id) => (items.has(id) ? [itemView(items.get(id)!)] : [])),
        ...(c.comparison ? { comparison: c.comparison } : {}),
        ...(c.decision ? { decision: c.decision } : {}),
        canStart: !!c.decision && proposalSpec(c.decision, c) !== undefined,
      }));
    const others = report.items
      .filter((i) => !clustered.has(i.id) && i.relevance > 0)
      .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
      .slice(0, MAX_OTHERS)
      .map(itemView);
    return { generatedAt: report.generatedAt, provider: report.provider, clusters, others, needsHuman: report.needsHuman.length, stats: report.stats };
  }
}

/** What Orka lacks first (P1 to P3), then what is not decided, then what Orka has, then what it does not want. */
function rank(cluster: RadarCluster): number {
  const d = cluster.decision;
  if (!d) return 3;
  if (d.decision === 'gap') return Number(d.priority[1]) - 1;
  return d.decision === 'already_have' ? 4 : 5;
}

function itemView(item: RadarItem): RadarItemView {
  const url = radarLinkTarget(item.url);
  return {
    id: item.id,
    vendor: item.vendor,
    product: item.product,
    title: item.title,
    summary: item.summary,
    kind: item.kind,
    relevance: item.relevance,
    ...(item.match ? { match: item.match } : {}),
    ...(url ? { url } : {}),
    ...(item.published ? { published: item.published } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
