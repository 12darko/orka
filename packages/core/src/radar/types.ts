/**
 * The radar watches public release notes of other AI coding tools. It sleeps (feeds are polled
 * with conditional requests, no model calls) until new entries appear, then summarizes them,
 * groups similar features across vendors, compares the approaches and decides what Orka lacks.
 * Everything runs on the user's PC with the user's own provider; nothing is published.
 */

/** Version of the report format, bumped on any incompatible change. */
export const RADAR_SCHEMA_VERSION = 1;

/** What every comparison is based on, stated in each one. */
export const RADAR_BASIS = 'public release notes only';

export type RadarSourceKind = 'atom' | 'rss' | 'markdown';

/** One feed of release notes. Users can edit the list; `validateSources` checks it. */
export interface RadarSource {
  /** Lowercase letters, digits and dashes; part of every entry id, so keep it stable. */
  id: string;
  vendor: string;
  product: string;
  /** A hint: Atom and RSS feeds are read by the same extractor. */
  kind: RadarSourceKind;
  /** HTTPS only. Its host must be in `allowHosts`. */
  url: string;
  /** Where a person reads these notes; markdown entries link here. */
  homepage?: string;
  /** Hosts this source may redirect to and link to. */
  allowHosts: string[];
  /** Regex for the release tag of stable releases; default `^v?\d+\.\d+\.\d+$`. Entries without a tag are kept. */
  stable?: string;
  /** Case-insensitive regex an entry title must match (e.g. "copilot" for a vendor-wide changelog). */
  titleFilter?: string;
  /** The feed is fetched at most this often. */
  minIntervalHours: number;
  /** Larger responses are cut here; a cut-off last entry is dropped. */
  maxBytes: number;
  enabled: boolean;
}

/** One release-note entry as read from a feed. `title` and `text` are untrusted. */
export interface RadarEntry {
  /** sha256(sourceId|guid|tag), hex. */
  id: string;
  sourceId: string;
  vendor: string;
  product: string;
  title: string;
  tag?: string;
  /** HTTPS link on one of the source's hosts. */
  url?: string;
  /** ISO date. */
  published?: string;
  /** Plain text, at most 12,000 characters. */
  text: string;
}

/** Feature areas a summary can be tagged with (a fixed list, so clusters and the UI can rely on it). */
export const RADAR_TAGS = [
  'agents',
  'subagents',
  'planning',
  'review',
  'permissions',
  'sandbox',
  'checkpoints',
  'diff-review',
  'terminal',
  'editor',
  'mcp',
  'skills',
  'memory',
  'context',
  'sessions',
  'models',
  'usage',
  'ui-layout',
  'cli',
  'hooks',
  'git',
  'browser',
  'web',
  'multimodal',
  'remote',
  'ide-integration',
  'performance',
  'other',
] as const;
export type RadarTag = (typeof RADAR_TAGS)[number];

export const RADAR_ITEM_KINDS = ['feature', 'improvement', 'fix', 'security', 'deprecation', 'other'] as const;
export type RadarItemKind = (typeof RADAR_ITEM_KINDS)[number];

/** How an item relates to Orka's feature inventory. */
export const RADAR_MATCHES = ['have', 'partial', 'gap', 'not_for_orka'] as const;
export type RadarMatch = (typeof RADAR_MATCHES)[number];

export type RadarRelevance = 0 | 1 | 2 | 3;

/** One change from an entry, in the model's own words. Never holds release-note text. */
export interface RadarItem {
  id: string;
  entryId: string;
  sourceId: string;
  vendor: string;
  product: string;
  url?: string;
  published?: string;
  /** At most 80 characters. */
  title: string;
  /** A paraphrase, at most 280 characters. */
  summary: string;
  kind: RadarItemKind;
  /** 0 = not about coding tools ... 3 = a significant capability for an agentic IDE. */
  relevance: RadarRelevance;
  tags: RadarTag[];
  /** Filled by the inventory stage; missing when that stage failed. */
  match?: RadarMatch;
  featureIds?: string[];
}

export interface RadarApproach {
  /** A vendor of the cluster, or "Orka". */
  vendor: string;
  /** At most 200 characters. */
  approach: string;
}

export const RADAR_CONFIDENCE = ['low', 'medium', 'high'] as const;
export type RadarConfidence = (typeof RADAR_CONFIDENCE)[number];

export interface RadarComparison {
  approaches: RadarApproach[];
  /** At most 600 characters. */
  assessment: string;
  confidence: RadarConfidence;
  basis: typeof RADAR_BASIS;
}

/** What an implementing session gets: validated fields only, never release-note text. */
export interface RadarProposal {
  title: string;
  problem: string;
  /** 1 to 8 items. */
  acceptanceCriteria: string[];
  areas: RadarTag[];
}

export const RADAR_VERDICTS = ['already_have', 'gap', 'not_for_orka'] as const;
export type RadarVerdict = (typeof RADAR_VERDICTS)[number];
export const RADAR_PRIORITIES = ['P1', 'P2', 'P3'] as const;
export type RadarPriority = (typeof RADAR_PRIORITIES)[number];
export const RADAR_EFFORTS = ['S', 'M', 'L'] as const;
export type RadarEffort = (typeof RADAR_EFFORTS)[number];

export interface RadarDecision {
  clusterKey: string;
  decision: RadarVerdict;
  priority: RadarPriority;
  effort: RadarEffort;
  /** Fits Orka's rules: permission system, append-only conversation, few dependencies, localized UI. */
  fitsPrinciples: boolean;
  /** At most 400 characters; empty when the inventory decided. */
  rationale: string;
  /** `inventory`: every item matched the inventory the same way, so no model call was needed. */
  decidedBy: 'model' | 'inventory';
  /** Only for `gap`. */
  proposal?: RadarProposal;
}

/** Similar features across vendors. */
export interface RadarCluster {
  /** Stable across runs: the cluster stage reuses keys from the previous report. */
  key: string;
  title: string;
  tags: RadarTag[];
  itemIds: string[];
  vendors: string[];
  /** The highest relevance of its items. */
  relevance: RadarRelevance;
  comparison?: RadarComparison;
  decision?: RadarDecision;
}

export const RADAR_STAGES = ['summarize', 'map', 'cluster', 'compare', 'decide'] as const;
export type RadarStage = (typeof RADAR_STAGES)[number];

/** Something the model could not answer validly twice; a person has to look at it. */
export interface RadarNeedsHuman {
  stage: RadarStage;
  /** Entry id, cluster key or item ids. */
  subject: string;
  title: string;
  /** What the validator rejected (English, technical). */
  reason: string;
}

export interface RadarRunStats {
  entries: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Entries left for the next run (caps, call budget, an error). */
  left: number;
  stopped?: 'budget' | 'error' | 'aborted';
  error?: string;
}

export interface RadarReport {
  schema: typeof RADAR_SCHEMA_VERSION;
  generatedAt: string;
  basis: typeof RADAR_BASIS;
  provider: { id: string; model: string };
  sources: Array<{ id: string; vendor: string; product: string; url: string }>;
  items: RadarItem[];
  clusters: RadarCluster[];
  needsHuman: RadarNeedsHuman[];
  stats: RadarRunStats;
}
