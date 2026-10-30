import { t } from '../i18n';
import {
  RADAR_BASIS,
  RADAR_ITEM_KINDS,
  RADAR_MATCHES,
  RADAR_SCHEMA_VERSION,
  RADAR_STAGES,
  type RadarCluster,
  type RadarDecision,
  type RadarItem,
  type RadarItemKind,
  type RadarNeedsHuman,
  type RadarReport,
  type RadarRunStats,
  type RadarSource,
  type RadarTag,
  RADAR_TAGS,
} from './types';
import { checkComparison, checkDecision, checkProposal, cleanModelText, isSlug, LIMITS, oneOf, text } from './validate';

export interface ReportParts {
  now: Date;
  provider: { id: string; model: string };
  sources: readonly RadarSource[];
  items: RadarItem[];
  clusters: RadarCluster[];
  needsHuman: RadarNeedsHuman[];
  stats: RadarRunStats;
}

export function buildReport(parts: ReportParts): RadarReport {
  return {
    schema: RADAR_SCHEMA_VERSION,
    generatedAt: parts.now.toISOString(),
    basis: RADAR_BASIS,
    provider: { id: parts.provider.id, model: parts.provider.model },
    sources: parts.sources.map((s) => ({ id: s.id, vendor: s.vendor, product: s.product, url: s.url })),
    items: parts.items,
    clusters: parts.clusters,
    needsHuman: parts.needsHuman,
    stats: parts.stats,
  };
}

export interface MergeLimits {
  items: number;
  clusters: number;
  needsHuman: number;
}

const MERGE_LIMITS: MergeLimits = { items: 500, clusters: 150, needsHuman: 100 };

/**
 * One report for the panel: `next` (a run over new entries) on top of `previous`. Clusters with
 * the same key are joined; the newer comparison and decision win; the oldest items go first
 * when a cap is reached.
 */
export function mergeReports(previous: RadarReport | undefined, next: RadarReport, limits: Partial<MergeLimits> = {}): RadarReport {
  if (!previous) return next;
  const cap = { ...MERGE_LIMITS, ...limits };
  const seen = new Set<string>();
  const items = [...next.items, ...previous.items].filter((i) => !seen.has(i.id) && seen.add(i.id)).slice(0, cap.items);
  const kept = new Set(items.map((i) => i.id));
  const byKey = new Map<string, RadarCluster>();
  for (const c of [...next.clusters, ...previous.clusters]) {
    const known = byKey.get(c.key);
    if (!known) byKey.set(c.key, { ...c, itemIds: [...c.itemIds], vendors: [...c.vendors], tags: [...c.tags] });
    else {
      // `next` came first, so `known` holds the newer title, comparison and decision.
      known.itemIds = [...new Set([...known.itemIds, ...c.itemIds])];
      known.vendors = [...new Set([...known.vendors, ...c.vendors])];
      known.tags = [...new Set([...known.tags, ...c.tags])].slice(0, 6);
      known.relevance = Math.max(known.relevance, c.relevance) as RadarCluster['relevance'];
      known.comparison ??= c.comparison;
      known.decision ??= c.decision;
    }
  }
  const clusters = [...byKey.values()]
    .map((c) => ({ ...c, itemIds: c.itemIds.filter((id) => kept.has(id)) }))
    .filter((c) => c.itemIds.length > 0)
    .slice(0, cap.clusters);
  const reasons = new Set<string>();
  const needsHuman = [...next.needsHuman, ...previous.needsHuman].filter((n) => !reasons.has(`${n.stage}|${n.subject}`) && reasons.add(`${n.stage}|${n.subject}`)).slice(0, cap.needsHuman);
  return { ...next, items, clusters, needsHuman };
}

// ------------------------------------------------------------------ validation of a stored report

type Obj = Record<string, unknown>;
const asObject = (value: unknown): Obj | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined);
// eslint-disable-next-line no-control-regex
const plain = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value);
const httpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 1_000) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ITEM_ID = /^[0-9a-f]{16}-\d{1,2}$/;
const FEATURE_ID = /^[a-z0-9][a-z0-9.-]{1,63}$/;

/**
 * Check a report read back from disk (or from anywhere else) field by field with the same
 * rules the pipeline applied; text is cleaned again. Errors are technical (for a log).
 */
export function validateReport(value: unknown): { report?: RadarReport; errors: string[] } {
  const r = asObject(value);
  if (!r) return { errors: ['the report is not an object'] };
  if (r.schema !== RADAR_SCHEMA_VERSION) return { errors: [`unsupported schema ${String(r.schema).slice(0, 20)}`] };
  const errors: string[] = [];
  if (r.basis !== RADAR_BASIS) errors.push('basis');
  if (typeof r.generatedAt !== 'string' || !Number.isFinite(Date.parse(r.generatedAt))) errors.push('generatedAt');
  const provider = asObject(r.provider);
  if (!provider || !plain(provider.id, 60) || !plain(provider.model, 200)) errors.push('provider');
  const sources = Array.isArray(r.sources) && r.sources.length <= 50 ? r.sources : (errors.push('sources'), []);
  sources.forEach((raw, i) => {
    const s = asObject(raw);
    if (!s || typeof s.id !== 'string' || !SOURCE_ID.test(s.id) || !plain(s.vendor, 40) || !plain(s.product, 60) || !httpsUrl(s.url)) errors.push(`sources[${i}]`);
  });
  const items: RadarItem[] = [];
  const rawItems = Array.isArray(r.items) && r.items.length <= 1_000 ? r.items : (errors.push('items'), []);
  rawItems.forEach((raw, i) => {
    const item = readItem(errors, raw, `items[${i}]`);
    if (item) items.push(item);
  });
  const itemIds = new Set(items.map((i) => i.id));
  const clusters: RadarCluster[] = [];
  const rawClusters = Array.isArray(r.clusters) && r.clusters.length <= 300 ? r.clusters : (errors.push('clusters'), []);
  rawClusters.forEach((raw, i) => {
    const cluster = readCluster(errors, raw, `clusters[${i}]`, itemIds);
    if (cluster) clusters.push(cluster);
  });
  const needsHuman: RadarNeedsHuman[] = [];
  const rawNeeds = Array.isArray(r.needsHuman) && r.needsHuman.length <= 500 ? r.needsHuman : (errors.push('needsHuman'), []);
  rawNeeds.forEach((raw, i) => {
    const n = asObject(raw);
    const stage = n && RADAR_STAGES.find((s) => s === n.stage);
    if (!n || !stage || typeof n.subject !== 'string' || n.subject.length > 2_000 || typeof n.title !== 'string' || typeof n.reason !== 'string') errors.push(`needsHuman[${i}]`);
    else needsHuman.push({ stage, subject: n.subject, title: cleanModelText(n.title).slice(0, 200), reason: cleanModelText(n.reason).slice(0, 1_000) });
  });
  const stats = readStats(errors, r.stats);
  if (errors.length) return { errors };
  return {
    report: {
      schema: RADAR_SCHEMA_VERSION,
      generatedAt: r.generatedAt as string,
      basis: RADAR_BASIS,
      provider: { id: provider!.id as string, model: provider!.model as string },
      sources: sources.map((raw) => {
        const s = raw as Obj;
        return { id: s.id as string, vendor: s.vendor as string, product: s.product as string, url: s.url as string };
      }),
      items,
      clusters,
      needsHuman,
      stats: stats!,
    },
    errors,
  };
}

function readItem(errors: string[], raw: unknown, at: string): RadarItem | undefined {
  const i = asObject(raw);
  if (!i) return void errors.push(at);
  const before = errors.length;
  if (typeof i.id !== 'string' || !ITEM_ID.test(i.id)) errors.push(`${at}.id`);
  if (typeof i.entryId !== 'string' || !/^[0-9a-f]{64}$/.test(i.entryId)) errors.push(`${at}.entryId`);
  if (typeof i.sourceId !== 'string' || !SOURCE_ID.test(i.sourceId) || !plain(i.vendor, 40) || !plain(i.product, 60)) errors.push(`${at}.source`);
  if (i.url !== undefined && !httpsUrl(i.url)) errors.push(`${at}.url`);
  if (i.published !== undefined && (typeof i.published !== 'string' || !Number.isFinite(Date.parse(i.published)))) errors.push(`${at}.published`);
  const title = text(errors, i.title, `${at}.title`, LIMITS.title);
  const summary = text(errors, i.summary, `${at}.summary`, LIMITS.summary);
  const kind = oneOf(errors, i.kind, `${at}.kind`, RADAR_ITEM_KINDS);
  if (i.relevance !== 0 && i.relevance !== 1 && i.relevance !== 2 && i.relevance !== 3) errors.push(`${at}.relevance`);
  const tags = readTags(errors, i.tags, `${at}.tags`, LIMITS.tagsPerItem);
  const match = i.match === undefined ? undefined : oneOf(errors, i.match, `${at}.match`, RADAR_MATCHES);
  const featureIds = i.featureIds === undefined ? undefined : Array.isArray(i.featureIds) && i.featureIds.length <= LIMITS.featureIdsPerItem && i.featureIds.every((f) => typeof f === 'string' && FEATURE_ID.test(f)) ? (i.featureIds as string[]) : void errors.push(`${at}.featureIds`);
  if (errors.length > before) return undefined;
  return {
    id: i.id as string,
    entryId: i.entryId as string,
    sourceId: i.sourceId as string,
    vendor: i.vendor as string,
    product: i.product as string,
    ...(i.url !== undefined ? { url: new URL(i.url as string).href } : {}),
    ...(i.published !== undefined ? { published: i.published as string } : {}),
    title: title!,
    summary: summary!,
    kind: kind!,
    relevance: i.relevance as RadarItem['relevance'],
    tags: tags!,
    ...(match ? { match } : {}),
    ...(featureIds ? { featureIds: [...featureIds] } : {}),
  };
}

function readTags(errors: string[], value: unknown, at: string, max: number): RadarTag[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return void errors.push(at);
  const out = value.map((v) => RADAR_TAGS.find((tag) => tag === v));
  if (out.some((tag) => !tag)) return void errors.push(at);
  return [...new Set(out as RadarTag[])];
}

function readCluster(errors: string[], raw: unknown, at: string, itemIds: Set<string>): RadarCluster | undefined {
  const c = asObject(raw);
  if (!c) return void errors.push(at);
  const before = errors.length;
  const key = typeof c.key === 'string' && isSlug(c.key) ? c.key : void errors.push(`${at}.key`);
  const title = text(errors, c.title, `${at}.title`, LIMITS.title);
  const tags = readTags(errors, c.tags, `${at}.tags`, 6);
  const ids = Array.isArray(c.itemIds) && c.itemIds.length > 0 && c.itemIds.every((id) => typeof id === 'string' && itemIds.has(id)) ? (c.itemIds as string[]) : void errors.push(`${at}.itemIds`);
  const vendors = Array.isArray(c.vendors) && c.vendors.length > 0 && c.vendors.length <= 50 && c.vendors.every((v) => plain(v, 40)) ? (c.vendors as string[]) : void errors.push(`${at}.vendors`);
  if (c.relevance !== 0 && c.relevance !== 1 && c.relevance !== 2 && c.relevance !== 3) errors.push(`${at}.relevance`);
  let comparison: RadarCluster['comparison'];
  if (c.comparison !== undefined && vendors) {
    const raw = asObject(c.comparison);
    const checked = raw ? checkComparison(raw, vendors, true, { requireAll: false }) : { errors: ['not an object'] };
    if (!checked.value || raw!.basis !== RADAR_BASIS) errors.push(`${at}.comparison: ${checked.errors.slice(0, 3).join('; ')}`);
    else comparison = { ...checked.value, basis: RADAR_BASIS };
  }
  let decision: RadarDecision | undefined;
  if (c.decision !== undefined) {
    const raw = asObject(c.decision);
    const checked = raw ? checkDecision(raw, { emptyRationale: true }) : { errors: ['not an object'] };
    if (!checked.value || raw!.clusterKey !== key || (raw!.decidedBy !== 'model' && raw!.decidedBy !== 'inventory')) errors.push(`${at}.decision: ${checked.errors.slice(0, 3).join('; ')}`);
    else decision = { clusterKey: key!, ...checked.value, decidedBy: raw!.decidedBy as RadarDecision['decidedBy'] };
  }
  if (errors.length > before) return undefined;
  return {
    key: key!,
    title: title!,
    tags: tags!,
    itemIds: [...ids!],
    vendors: [...vendors!],
    relevance: c.relevance as RadarCluster['relevance'],
    ...(comparison ? { comparison } : {}),
    ...(decision ? { decision } : {}),
  };
}

function readStats(errors: string[], value: unknown): RadarRunStats | undefined {
  const s = asObject(value);
  const count = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (!s || !count(s.entries) || !count(s.calls) || !count(s.inputTokens) || !count(s.outputTokens) || !count(s.left)) return void errors.push('stats');
  if (s.stopped !== undefined && s.stopped !== 'budget' && s.stopped !== 'error' && s.stopped !== 'aborted') return void errors.push('stats.stopped');
  return {
    entries: s.entries as number,
    calls: s.calls as number,
    inputTokens: s.inputTokens as number,
    outputTokens: s.outputTokens as number,
    left: s.left as number,
    ...(s.stopped ? { stopped: s.stopped as RadarRunStats['stopped'] } : {}),
    ...(typeof s.error === 'string' ? { error: cleanModelText(s.error).slice(0, 300) } : {}),
  };
}

// ------------------------------------------------------------------ Markdown

/**
 * Any text as inert Markdown inline content: URLs, tags and links removed, line breaks folded,
 * HTML characters as entities and every Markdown punctuation character backslash-escaped.
 */
export function escapeMarkdown(value: string): string {
  return cleanModelText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+\-.!|~:]/g, '\\$&');
}

/** A link target the report renders (and the apps open): https only, no credentials, normalized by the URL parser (no spaces or angle brackets). */
export function radarLinkTarget(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function kindLabel(kind: RadarItemKind): string {
  switch (kind) {
    case 'feature':
      return t('feature');
    case 'improvement':
      return t('improvement');
    case 'fix':
      return t('fix');
    case 'security':
      return t('security');
    case 'deprecation':
      return t('deprecation');
    default:
      return t('other');
  }
}

function stoppedText(stats: RadarRunStats): string {
  const reason = stats.stopped === 'budget' ? t('the call limit was reached') : stats.stopped === 'aborted' ? t('it was cancelled') : t('the provider failed: {error}', { error: stats.error ?? '' });
  return t('This run stopped early ({reason}); {n} entries are left for the next run.', { reason, n: stats.left });
}

/** The report as Markdown for the panel. Every value from a feed or a model is escaped. */
export function renderReportMarkdown(report: RadarReport): string {
  const e = escapeMarkdown;
  const out: string[] = [`# ${e(t('Radar report'))}`, ''];
  out.push(
    e(t('Generated {date} with {provider}. Based on public release notes only; summaries and comparisons are written by a model and can be wrong.', { date: report.generatedAt.slice(0, 10), provider: `${report.provider.id} / ${report.provider.model}` })),
  );
  if (report.stats.stopped) out.push('', e(stoppedText(report.stats)));
  const vendorsOf = (c: RadarCluster) => c.vendors.map(e).join(', ');
  const section = (title: string, clusters: RadarCluster[], body: (c: RadarCluster) => string[]) => {
    if (!clusters.length) return;
    out.push('', `## ${e(title)}`);
    for (const c of clusters) out.push(...body(c));
  };
  const priority = (c: RadarCluster) => (c.decision ? Number(c.decision.priority[1]) : 9);
  const decided = (verdict: string) => report.clusters.filter((c) => c.decision?.decision === verdict);
  section(t('What Orka lacks'), decided('gap').sort((a, b) => priority(a) - priority(b)), (c) => {
    const d = c.decision!;
    const lines = ['', `### ${e(c.title)}`, '', e(t('Priority {priority}, effort {effort}. Seen at: {vendors}', { priority: d.priority, effort: d.effort, vendors: c.vendors.join(', ') }))];
    if (!d.fitsPrinciples) lines.push('', e(t("Needs care: it may not fit Orka's rules as it is.")));
    if (d.rationale) lines.push('', e(d.rationale));
    if (c.comparison) {
      lines.push('', `${e(c.comparison.assessment)} ${e(t('(confidence: {confidence})', { confidence: confidenceLabel(c.comparison.confidence) }))}`, '');
      for (const a of c.comparison.approaches) lines.push(`- **${e(a.vendor)}:** ${e(a.approach)}`);
    }
    if (d.proposal) {
      lines.push('', `**${e(t('Proposal'))}:** ${e(d.proposal.title)}`, '', e(d.proposal.problem), '');
      d.proposal.acceptanceCriteria.forEach((criterion, i) => lines.push(`${i + 1}. ${e(criterion)}`));
    }
    return lines;
  });
  const short = (c: RadarCluster) => {
    const why = c.decision?.decidedBy === 'inventory' ? t('Decided from the feature inventory.') : (c.decision?.rationale ?? '');
    return [`- **${e(c.title)}** (${vendorsOf(c)})${why ? `: ${e(why)}` : ''}`];
  };
  section(t('Already in Orka'), decided('already_have'), short);
  section(t('Not for Orka'), decided('not_for_orka'), short);
  section(t('Not decided yet'), report.clusters.filter((c) => !c.decision), (c) => [`- **${e(c.title)}** (${vendorsOf(c)})`]);
  // Relevance 0 is not about coding tools (pricing, events, and notes that tried to instruct the model).
  const shown = report.items.filter((i) => i.relevance > 0);
  if (shown.length) {
    out.push('', `## ${e(t('New changes'))}`);
    const vendors = [...new Set(shown.map((i) => i.vendor))];
    for (const vendor of vendors) {
      out.push('', `### ${e(vendor)}`, '');
      for (const item of shown.filter((i) => i.vendor === vendor)) {
        const href = radarLinkTarget(item.url);
        const title = `${e(item.product)}: ${e(item.title)}`;
        out.push(`- ${href ? `[${title}](<${href}>)` : title}: ${e(item.summary)} _(${e(kindLabel(item.kind))}, ${e(t('relevance {n}', { n: item.relevance }))})_`);
      }
    }
  }
  if (report.needsHuman.length) {
    out.push('', `## ${e(t('Needs a human'))}`, '', e(t('The model could not answer these validly twice; nothing from them was used.')), '');
    for (const n of report.needsHuman) out.push(`- ${e(n.stage)}${n.title ? `, ${e(n.title)}` : ''}: ${e(n.reason)}`);
  }
  if (report.clusters.length === 0 && shown.length === 0 && report.needsHuman.length === 0) out.push('', e(t('Nothing new.')));
  return `${out.join('\n')}\n`;
}

function confidenceLabel(confidence: string): string {
  return confidence === 'high' ? t('high') : confidence === 'medium' ? t('medium') : t('low');
}

// ------------------------------------------------------------------ proposal spec

/**
 * The text for "start a session to implement this": the validated proposal fields and Orka's
 * rules, nothing else. The implementing session never sees release-note text or the model's
 * free-form comparison. Undefined unless the decision is a gap with a valid proposal (checked
 * again here, since the report may have been read from disk). A prompt for a model: English.
 */
export function proposalSpec(decision: RadarDecision, cluster?: Pick<RadarCluster, 'vendors'>): string | undefined {
  if (decision.decision !== 'gap' || !decision.proposal) return undefined;
  const checked = checkProposal(decision.proposal);
  if (!checked.value || !/^P[123]$/.test(decision.priority) || !/^[SML]$/.test(decision.effort)) return undefined;
  const p = checked.value;
  const vendors = (cluster?.vendors ?? []).filter((v) => /^[\w .&()-]{1,40}$/.test(v));
  return [
    `Implement this feature in Orka: ${p.title}`,
    '',
    `Priority ${decision.priority}, effort ${decision.effort}. Areas: ${p.areas.join(', ')}.`,
    ...(vendors.length ? [`Other tools that have something similar: ${vendors.join(', ')}.`] : []),
    '',
    'Problem:',
    p.problem,
    '',
    'Acceptance criteria:',
    ...p.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    "Orka's rules (see CONTRIBUTING.md):",
    '- Anything that edits files or runs commands goes through the permission system; never add a path that skips approval.',
    '- The model conversation stays append-only (system prompt and tool list fixed during a task).',
    '- No new runtime dependencies without a strong reason.',
    '- Every user-facing string goes through t() with a Turkish entry in packages/core/src/i18n/tr.ts.',
    '- New behaviour has tests; npm run typecheck and npm test pass.',
    '',
    "This request comes from an automated comparison of other tools' public release notes. Check that it makes sense for Orka before building it, design it Orka's way, and propose a plan first.",
  ].join('\n');
}
