/**
 * Hand-written validators for the radar's model replies. Every stage answers with one JSON
 * object; anything outside the enums or over a length cap is rejected (the pipeline then asks
 * once for a repair). Error messages go back to the model, so they stay English.
 */
import {
  RADAR_CONFIDENCE,
  RADAR_EFFORTS,
  RADAR_ITEM_KINDS,
  RADAR_MATCHES,
  RADAR_PRIORITIES,
  RADAR_TAGS,
  RADAR_VERDICTS,
  type RadarApproach,
  type RadarConfidence,
  type RadarEffort,
  type RadarItemKind,
  type RadarMatch,
  type RadarPriority,
  type RadarProposal,
  type RadarRelevance,
  type RadarTag,
  type RadarVerdict,
} from './types';

export interface Checked<T> {
  value?: T;
  errors: string[];
}

export const LIMITS = {
  title: 80,
  summary: 280,
  itemsPerEntry: 15,
  tagsPerItem: 4,
  approach: 200,
  assessment: 600,
  rationale: 400,
  problem: 600,
  criterion: 200,
  criteria: 8,
  areas: 5,
  featureIdsPerItem: 5,
  clusters: 60,
} as const;

/** Summaries may not share this many consecutive words with the release notes. */
export const VERBATIM_WORDS = 10;
const MAX_REPLY = 200_000;

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;
const URL_SCHEME = /\b(?:https?|ftp|file|javascript|data|vbscript|mailto):\S*/gi;

/**
 * Model text as plain text: HTML tags, Markdown links and images (their label stays), URLs,
 * control and bidi characters are removed and whitespace is collapsed. Linear on any input.
 */
export function cleanModelText(text: string): string {
  return text
    .slice(0, 20_000)
    .replace(/<[^<>]*>/g, ' ')
    .replace(/!?\[([^[\]]*)\]\([^()]*\)/g, '$1')
    .replace(URL_SCHEME, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(INVISIBLE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Why text may not go into a proposal as it is (proposals reach an implementing session), or undefined. */
export function markupReason(text: string): string | undefined {
  if (/<[a-z!/?][^<>]*>/i.test(text)) return 'contains HTML';
  if (/\b(?:https?|ftp|file|javascript|data|vbscript|mailto):/i.test(text) || /\bwww\./i.test(text)) return 'contains a URL';
  if (text.includes('](')) return 'contains a Markdown link';
  if (text.includes('```')) return 'contains a code block';
  return undefined;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** Whether `candidate` repeats `words` or more consecutive words of `source` (case and punctuation ignored). */
export function sharesVerbatim(candidate: string, source: string, words = VERBATIM_WORDS): boolean {
  const mine = candidate.toLowerCase().match(WORD) ?? [];
  if (mine.length < words) return false;
  const theirs = source.slice(0, 50_000).toLowerCase().match(WORD) ?? [];
  const runs = new Set<string>();
  for (let i = 0; i + words <= theirs.length; i++) runs.add(theirs.slice(i, i + words).join(' '));
  for (let i = 0; i + words <= mine.length; i++) if (runs.has(mine.slice(i, i + words).join(' '))) return true;
  return false;
}

/** The JSON object in a reply (a code fence or a sentence around it is tolerated). */
export function parseJsonReply(text: string): { value?: Record<string, unknown>; error?: string } {
  if (text.length > MAX_REPLY) return { error: 'The reply is too long.' };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return { error: 'The reply contains no JSON object.' };
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'The reply must be one JSON object.' };
    return { value: value as Record<string, unknown> };
  } catch (error) {
    return { error: `The reply is not valid JSON (${(error instanceof Error ? error.message : String(error)).slice(0, 120)}).` };
  }
}

/** A cluster slug: 2-48 lowercase letters, digits and single dashes. */
export function isSlug(text: string): boolean {
  return /^[a-z0-9-]{2,48}$/.test(text) && !text.startsWith('-') && !text.endsWith('-') && !text.includes('--');
}

// ------------------------------------------------------------------ field readers

type Obj = Record<string, unknown>;

const asObject = (value: unknown): Obj | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined);

export function text(errors: string[], value: unknown, path: string, max: number, opts: { strict?: boolean; min?: number } = {}): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${path}: must be a string`);
    return undefined;
  }
  if (opts.strict) {
    const reason = markupReason(value);
    if (reason) {
      errors.push(`${path}: ${reason}; write plain text`);
      return undefined;
    }
  }
  const clean = cleanModelText(value);
  if (clean.length < (opts.min ?? 1)) errors.push(`${path}: must not be empty`);
  else if (clean.length > max) errors.push(`${path}: ${clean.length} characters, at most ${max} allowed`);
  else return clean;
  return undefined;
}

export function oneOf<T extends string>(errors: string[], value: unknown, path: string, allowed: readonly T[]): T | undefined {
  const normal = typeof value === 'string' ? value.trim().toLowerCase() : value;
  const found = allowed.find((a) => a.toLowerCase() === normal);
  if (found === undefined) errors.push(`${path}: must be one of ${allowed.join(', ')}`);
  return found;
}

function list(errors: string[], value: unknown, path: string, min: number, max: number): unknown[] | undefined {
  if (!Array.isArray(value)) errors.push(`${path}: must be a list`);
  else if (value.length < min || value.length > max) errors.push(`${path}: ${value.length} entries, ${min} to ${max} allowed`);
  else return value;
  return undefined;
}

function tags(errors: string[], value: unknown, path: string, max: number): RadarTag[] | undefined {
  const raw = list(errors, value, path, 1, max);
  if (!raw) return undefined;
  const out: RadarTag[] = [];
  const before = errors.length;
  raw.forEach((t, i) => {
    const tag = oneOf(errors, t, `${path}[${i}]`, RADAR_TAGS);
    if (tag && !out.includes(tag)) out.push(tag);
  });
  return errors.length === before ? out : undefined;
}

// ------------------------------------------------------------------ stages

export interface SummaryDraft {
  title: string;
  summary: string;
  kind: RadarItemKind;
  relevance: RadarRelevance;
  tags: RadarTag[];
}

/** Stage 1: {"items":[{title, summary, kind, relevance, tags}]}, paraphrased from `sourceText`. */
export function checkSummaries(value: Obj, sourceText: string): Checked<SummaryDraft[]> {
  const errors: string[] = [];
  const items = list(errors, value.items, 'items', 0, LIMITS.itemsPerEntry);
  const out: SummaryDraft[] = [];
  items?.forEach((raw, i) => {
    const item = asObject(raw);
    const at = `items[${i}]`;
    if (!item) return void errors.push(`${at}: must be an object`);
    const before = errors.length;
    const title = text(errors, item.title, `${at}.title`, LIMITS.title);
    const summary = text(errors, item.summary, `${at}.summary`, LIMITS.summary);
    const kind = oneOf(errors, item.kind, `${at}.kind`, RADAR_ITEM_KINDS);
    const relevance = item.relevance;
    if (relevance !== 0 && relevance !== 1 && relevance !== 2 && relevance !== 3) errors.push(`${at}.relevance: must be 0, 1, 2 or 3`);
    const itemTags = tags(errors, item.tags, `${at}.tags`, LIMITS.tagsPerItem);
    for (const [field, v] of [['title', title], ['summary', summary]] as const) {
      if (v && sharesVerbatim(v, sourceText)) errors.push(`${at}.${field}: copies ${VERBATIM_WORDS} or more consecutive words from the release notes; paraphrase it`);
    }
    if (errors.length === before) out.push({ title: title!, summary: summary!, kind: kind!, relevance: relevance as RadarRelevance, tags: itemTags! });
  });
  return errors.length ? { errors } : { value: out, errors };
}

export interface MappingDraft {
  match: RadarMatch;
  featureIds: string[];
}

/** Stage 2: {"mappings":[{id, match, featureIds}]}, exactly one per item id. */
export function checkMappings(value: Obj, itemIds: readonly string[], featureIds: ReadonlySet<string>): Checked<Map<string, MappingDraft>> {
  const errors: string[] = [];
  const out = new Map<string, MappingDraft>();
  const mappings = list(errors, value.mappings, 'mappings', 1, itemIds.length);
  mappings?.forEach((raw, i) => {
    const m = asObject(raw);
    const at = `mappings[${i}]`;
    if (!m) return void errors.push(`${at}: must be an object`);
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!itemIds.includes(id)) return void errors.push(`${at}.id: not one of the change ids`);
    if (out.has(id)) return void errors.push(`${at}.id: ${id} is mapped twice`);
    const before = errors.length;
    const match = oneOf(errors, m.match, `${at}.match`, RADAR_MATCHES);
    const ids = m.featureIds === undefined ? [] : list(errors, m.featureIds, `${at}.featureIds`, 0, LIMITS.featureIdsPerItem);
    const features: string[] = [];
    ids?.forEach((f, j) => {
      if (typeof f !== 'string' || !featureIds.has(f)) errors.push(`${at}.featureIds[${j}]: not an id from the inventory`);
      else if (!features.includes(f)) features.push(f);
    });
    if ((match === 'have' || match === 'partial') && ids && features.length === 0) errors.push(`${at}.featureIds: name the inventory features for "${match}"`);
    if (errors.length === before) out.set(id, { match: match!, featureIds: features });
  });
  const missing = itemIds.filter((id) => !out.has(id));
  if (mappings && missing.length) errors.push(`mappings: missing ${missing.slice(0, 10).join(', ')}`);
  return errors.length ? { errors } : { value: out, errors };
}

export interface ClusterDraft {
  key: string;
  title: string;
  itemIds: string[];
}

/** Stage 3: {"clusters":[{key, title, itemIds}]}; every item in exactly one cluster; keys existing or "new:<slug>". */
export function checkClusters(value: Obj, itemIds: readonly string[], existingKeys: ReadonlySet<string>): Checked<ClusterDraft[]> {
  const errors: string[] = [];
  const out: ClusterDraft[] = [];
  const placed = new Set<string>();
  const keys = new Set<string>();
  const clusters = list(errors, value.clusters, 'clusters', 1, LIMITS.clusters);
  clusters?.forEach((raw, i) => {
    const c = asObject(raw);
    const at = `clusters[${i}]`;
    if (!c) return void errors.push(`${at}: must be an object`);
    const before = errors.length;
    const rawKey = typeof c.key === 'string' ? c.key.trim() : '';
    const key = rawKey.startsWith('new:') ? rawKey.slice(4) : rawKey;
    if (!rawKey.startsWith('new:') && !existingKeys.has(rawKey)) errors.push(`${at}.key: use an existing key or "new:<slug>"`);
    else if (!isSlug(key)) errors.push(`${at}.key: the slug must be 2-48 lowercase letters, digits and dashes`);
    else if (keys.has(key)) errors.push(`${at}.key: ${key} is used twice`);
    const title = text(errors, c.title, `${at}.title`, LIMITS.title);
    const ids = list(errors, c.itemIds, `${at}.itemIds`, 1, itemIds.length);
    const members: string[] = [];
    ids?.forEach((id, j) => {
      if (typeof id !== 'string' || !itemIds.includes(id)) errors.push(`${at}.itemIds[${j}]: not one of the change ids`);
      else if (placed.has(id)) errors.push(`${at}.itemIds[${j}]: ${id} is already in a cluster`);
      else {
        placed.add(id);
        members.push(id);
      }
    });
    if (errors.length === before) {
      keys.add(key);
      out.push({ key, title: title!, itemIds: members });
    }
  });
  const missing = itemIds.filter((id) => !placed.has(id));
  if (clusters && missing.length) errors.push(`clusters: changes not placed: ${missing.slice(0, 10).join(', ')}`);
  return errors.length ? { errors } : { value: out, errors };
}

export interface ComparisonDraft {
  approaches: RadarApproach[];
  assessment: string;
  confidence: RadarConfidence;
}

/**
 * Stage 4: {"approaches":[{vendor, approach}], assessment, confidence}; one approach per vendor
 * (Orka optional). `requireAll: false` is for stored reports, where a cluster may have gained
 * vendors after its comparison was written.
 */
export function checkComparison(value: Obj, vendors: readonly string[], allowOrka: boolean, opts: { requireAll?: boolean } = {}): Checked<ComparisonDraft> {
  const errors: string[] = [];
  const allowed = allowOrka ? [...vendors, 'Orka'] : [...vendors];
  const approaches: RadarApproach[] = [];
  const raw = list(errors, value.approaches, 'approaches', 1, allowed.length);
  raw?.forEach((r, i) => {
    const a = asObject(r);
    const at = `approaches[${i}]`;
    if (!a) return void errors.push(`${at}: must be an object`);
    const vendor = typeof a.vendor === 'string' ? allowed.find((v) => v.toLowerCase() === (a.vendor as string).trim().toLowerCase()) : undefined;
    if (!vendor) return void errors.push(`${at}.vendor: must be one of ${allowed.join(', ')}`);
    if (approaches.some((x) => x.vendor === vendor)) return void errors.push(`${at}.vendor: ${vendor} appears twice`);
    const approach = text(errors, a.approach, `${at}.approach`, LIMITS.approach);
    if (approach) approaches.push({ vendor, approach });
  });
  const missing = vendors.filter((v) => !approaches.some((a) => a.vendor === v));
  if (raw && missing.length && opts.requireAll !== false) errors.push(`approaches: missing ${missing.join(', ')}`);
  const assessment = text(errors, value.assessment, 'assessment', LIMITS.assessment);
  const confidence = oneOf(errors, value.confidence, 'confidence', RADAR_CONFIDENCE);
  return errors.length ? { errors } : { value: { approaches, assessment: assessment!, confidence: confidence! }, errors };
}

export interface DecisionDraft {
  decision: RadarVerdict;
  priority: RadarPriority;
  effort: RadarEffort;
  fitsPrinciples: boolean;
  rationale: string;
  proposal?: RadarProposal;
}

/** Stage 5: {decision, priority, effort, fitsPrinciples, rationale, proposal?}; a proposal exactly for "gap". */
export function checkDecision(value: Obj, opts: { emptyRationale?: boolean } = {}): Checked<DecisionDraft> {
  const errors: string[] = [];
  const decision = oneOf(errors, value.decision, 'decision', RADAR_VERDICTS);
  const priority = oneOf(errors, value.priority, 'priority', RADAR_PRIORITIES);
  const effort = oneOf(errors, value.effort, 'effort', RADAR_EFFORTS);
  if (typeof value.fitsPrinciples !== 'boolean') errors.push('fitsPrinciples: must be true or false');
  const rationale = opts.emptyRationale && value.rationale === '' ? '' : text(errors, value.rationale, 'rationale', LIMITS.rationale);
  let proposal: RadarProposal | undefined;
  if (decision === 'gap') {
    const checked = checkProposal(value.proposal, 'proposal');
    errors.push(...checked.errors);
    proposal = checked.value;
  }
  if (errors.length) return { errors };
  return {
    value: { decision: decision!, priority: priority!, effort: effort!, fitsPrinciples: value.fitsPrinciples as boolean, rationale: rationale!, ...(proposal ? { proposal } : {}) },
    errors,
  };
}

/**
 * A proposal spec, strictly: plain text only (no URLs, HTML, Markdown links or code), since it
 * is what an implementing session receives.
 */
export function checkProposal(value: unknown, path = 'proposal'): Checked<RadarProposal> {
  const errors: string[] = [];
  const p = asObject(value);
  if (!p) return { errors: [`${path}: required for "gap", an object`] };
  const title = text(errors, p.title, `${path}.title`, LIMITS.title, { strict: true });
  const problem = text(errors, p.problem, `${path}.problem`, LIMITS.problem, { strict: true });
  const criteria: string[] = [];
  list(errors, p.acceptanceCriteria, `${path}.acceptanceCriteria`, 1, LIMITS.criteria)?.forEach((c, i) => {
    const criterion = text(errors, c, `${path}.acceptanceCriteria[${i}]`, LIMITS.criterion, { strict: true });
    if (criterion) criteria.push(criterion);
  });
  const areas = tags(errors, p.areas, `${path}.areas`, LIMITS.areas);
  return errors.length ? { errors } : { value: { title: title!, problem: problem!, acceptanceCriteria: criteria, areas: areas! }, errors };
}
