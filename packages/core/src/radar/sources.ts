import { isIP } from 'node:net';
import { t } from '../i18n';
import type { RadarSource, RadarSourceKind } from './types';

/** Stable release tags unless a source says otherwise: no nightly, alpha, preview or rc. */
export const DEFAULT_STABLE_TAG = String.raw`^v?\d+\.\d+\.\d+$`;

/** Hosts the radar never fetches from, whatever a source list says. */
export const NEVER_FETCH_HOSTS: readonly string[] = ['openai.com', 'www.openai.com', 'chatgpt.com', 'www.chatgpt.com'];

const MAX_SOURCES = 50;
const MAX_PATTERN = 200;
const MIN_BYTES = 10_000;
const MAX_BYTES = 16_000_000;
const KINDS: readonly RadarSourceKind[] = ['atom', 'rss', 'markdown'];

function githubReleases(id: string, vendor: string, product: string, repo: string, stable?: string): RadarSource {
  return {
    id,
    vendor,
    product,
    kind: 'atom',
    url: `https://github.com/${repo}/releases.atom`,
    allowHosts: ['github.com'],
    ...(stable ? { stable } : {}),
    minIntervalHours: 6,
    maxBytes: 2_000_000,
    enabled: true,
  };
}

/**
 * The "AI coding tools" preset: public, machine-readable feeds only. Claude Code is read from its
 * CHANGELOG.md instead of its releases feed, so its entries are not counted twice.
 */
export const DEFAULT_SOURCES: readonly RadarSource[] = [
  githubReleases('codex', 'OpenAI', 'Codex CLI', 'openai/codex', String.raw`^rust-v\d+\.\d+\.\d+$`),
  githubReleases('gemini-cli', 'Google', 'Gemini CLI', 'google-gemini/gemini-cli'),
  githubReleases('antigravity-cli', 'Google', 'Antigravity CLI', 'google-antigravity/antigravity-cli'),
  githubReleases('zed', 'Zed Industries', 'Zed', 'zed-industries/zed'),
  githubReleases('copilot-cli', 'GitHub', 'Copilot CLI', 'github/copilot-cli'),
  githubReleases('cline', 'Cline', 'Cline', 'cline/cline'),
  githubReleases('kilocode', 'Kilo Code', 'Kilo Code', 'Kilo-Org/kilocode'),
  githubReleases('opencode', 'Anomaly', 'OpenCode', 'anomalyco/opencode'),
  {
    id: 'claude-code',
    vendor: 'Anthropic',
    product: 'Claude Code',
    kind: 'markdown',
    url: 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
    homepage: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
    allowHosts: ['raw.githubusercontent.com', 'github.com'],
    minIntervalHours: 6,
    maxBytes: 4_000_000,
    enabled: true,
  },
  {
    id: 'cursor',
    vendor: 'Anysphere',
    product: 'Cursor',
    kind: 'rss',
    url: 'https://cursor.com/changelog/rss.xml',
    allowHosts: ['cursor.com', 'www.cursor.com'],
    minIntervalHours: 24,
    maxBytes: 4_000_000,
    enabled: true,
  },
  {
    id: 'kiro',
    vendor: 'AWS',
    product: 'Kiro',
    kind: 'atom',
    url: 'https://kiro.dev/changelog/feed.atom',
    allowHosts: ['kiro.dev'],
    minIntervalHours: 12,
    maxBytes: 4_000_000,
    enabled: true,
  },
  {
    id: 'vscode',
    vendor: 'Microsoft',
    product: 'VS Code',
    kind: 'rss',
    url: 'https://code.visualstudio.com/feed.xml',
    allowHosts: ['code.visualstudio.com'],
    minIntervalHours: 12,
    maxBytes: 4_000_000,
    enabled: true,
  },
  {
    id: 'github-copilot',
    vendor: 'GitHub',
    product: 'Copilot',
    kind: 'rss',
    url: 'https://github.blog/changelog/feed/',
    allowHosts: ['github.blog'],
    titleFilter: 'copilot',
    minIntervalHours: 12,
    maxBytes: 4_000_000,
    enabled: true,
  },
  {
    id: 'chatgpt-codex',
    vendor: 'OpenAI',
    product: 'ChatGPT Codex',
    kind: 'rss',
    url: 'https://learn.chatgpt.com/docs/changelog/rss.xml',
    allowHosts: ['learn.chatgpt.com'],
    minIntervalHours: 24,
    maxBytes: 8_000_000,
    enabled: true,
  },
];

/** A copy of the preset, for callers that let the user edit it. */
export function defaultSources(): RadarSource[] {
  return DEFAULT_SOURCES.map((s) => ({ ...s, allowHosts: [...s.allowHosts] }));
}

/**
 * Why a user-supplied pattern is unsafe to run on feed text, or undefined when it is fine.
 * Exponential backtracking needs a repeated group that itself repeats or branches, or a
 * backreference; those are refused. What is left stays fast on the short strings it is
 * applied to (tags and titles are cut to a few hundred characters).
 */
export function unsafePatternReason(pattern: string): string | undefined {
  if (pattern.length > MAX_PATTERN) return t('longer than {n} characters', { n: MAX_PATTERN });
  try {
    new RegExp(pattern, 'i');
  } catch {
    return t('not a valid regular expression');
  }
  const groups: Array<{ repeats: boolean; branches: boolean }> = [{ repeats: false, branches: false }];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const top = groups[groups.length - 1];
    if (c === '\\') {
      if (/[1-9k]/.test(pattern[i + 1] ?? '')) return t('backreferences are not allowed');
      i++;
    } else if (c === '[') {
      // A character class is one atom: skip to its end.
      i++;
      if (pattern[i] === '^') i++;
      if (pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
    } else if (c === '(') {
      groups.push({ repeats: false, branches: false });
      if (pattern[i + 1] === '?') {
        // (?: (?= (?! (?<= (?<! and (?<name>: skip the prefix so its "?" is not taken for a quantifier.
        i += 2;
        if (pattern[i] === '<' && pattern[i + 1] !== '=' && pattern[i + 1] !== '!') {
          while (i < pattern.length && pattern[i] !== '>') i++;
        } else if (pattern[i] === '<') i++;
      }
    } else if (c === ')') {
      const group = groups.length > 1 ? groups.pop()! : top;
      const next = pattern[i + 1];
      const repeated = next === '*' || next === '+' || next === '{';
      if (repeated && (group.repeats || group.branches)) return t('a repeated group may not contain repetition or alternatives');
      const parent = groups[groups.length - 1];
      if (group.repeats || repeated) parent.repeats = true;
      if (group.branches) parent.branches = true;
    } else if (c === '|') {
      top.branches = true;
    } else if (c === '*' || c === '+' || c === '{' || c === '?') {
      top.repeats = true;
    }
  }
  return undefined;
}

/** A host name of at least two labels; IP literals are refused (sources are public sites). */
export function isPublicHostName(host: string): boolean {
  if (host.length > 253 || isIP(host) || host === 'localhost' || host.endsWith('.localhost')) return false;
  const labels = host.split('.');
  if (labels.length < 2 || /^\d+$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => /^[a-z0-9-]{1,63}$/.test(l) && !l.startsWith('-') && !l.endsWith('-'));
}

export function isNeverFetched(host: string): boolean {
  return NEVER_FETCH_HOSTS.includes(host.toLowerCase());
}

/** An https URL without credentials on a public host name, or undefined. */
function httpsUrl(raw: unknown): URL | undefined {
  if (typeof raw !== 'string' || raw.length > 500) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !isPublicHostName(url.hostname)) return undefined;
  return url;
}

const plainText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  return text && text.length <= max && !/[\u0000-\u001f\u007f<>]/.test(text) ? text : undefined;
};

export interface SourceValidation {
  /** The valid sources, normalized (lowercase hosts). */
  sources: RadarSource[];
  /** One line per problem, for the user. */
  errors: string[];
}

/**
 * Check a user-edited source list (parsed JSON). Invalid sources are left out and reported;
 * the valid ones can be used right away.
 */
export function validateSources(value: unknown): SourceValidation {
  const errors: string[] = [];
  const list = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { sources?: unknown }).sources) ? (value as { sources: unknown[] }).sources : undefined;
  if (!list) return { sources: [], errors: [t('The source list must be a JSON array of sources.')] };
  if (list.length > MAX_SOURCES) errors.push(t('At most {n} sources; the rest are ignored.', { n: MAX_SOURCES }));
  const sources: RadarSource[] = [];
  const ids = new Set<string>();
  list.slice(0, MAX_SOURCES).forEach((raw, index) => {
    const problems: string[] = [];
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof s.id === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(s.id) ? s.id : undefined;
    const label = id ?? `#${index + 1}`;
    if (!id) problems.push(t('the id must be 1-48 lowercase letters, digits or dashes'));
    else if (ids.has(id)) problems.push(t('the id is used twice'));
    const vendor = plainText(s.vendor, 40);
    const product = plainText(s.product, 60);
    if (!vendor) problems.push(t('vendor must be 1-40 characters of plain text'));
    if (!product) problems.push(t('product must be 1-60 characters of plain text'));
    const kind = KINDS.includes(s.kind as RadarSourceKind) ? (s.kind as RadarSourceKind) : undefined;
    if (!kind) problems.push(t('kind must be atom, rss or markdown'));
    const allowHosts = Array.isArray(s.allowHosts) ? s.allowHosts.map((h) => (typeof h === 'string' ? h.trim().toLowerCase() : '')) : [];
    if (allowHosts.length === 0 || allowHosts.length > 5 || allowHosts.some((h) => !isPublicHostName(h)))
      problems.push(t('allowHosts must list 1-5 public host names'));
    if (allowHosts.some(isNeverFetched)) problems.push(t('{host} is never fetched', { host: allowHosts.find(isNeverFetched)! }));
    const url = httpsUrl(s.url);
    if (!url) problems.push(t('url must be an https address on a public host'));
    else if (isNeverFetched(url.hostname)) problems.push(t('{host} is never fetched', { host: url.hostname }));
    else if (!allowHosts.includes(url.hostname)) problems.push(t("allowHosts must contain the url's host ({host})", { host: url.hostname }));
    let homepage: string | undefined;
    if (s.homepage !== undefined) {
      const page = httpsUrl(s.homepage);
      if (!page || !allowHosts.includes(page.hostname)) problems.push(t('homepage must be an https address on one of allowHosts'));
      else homepage = page.href;
    }
    for (const key of ['stable', 'titleFilter'] as const) {
      if (s[key] === undefined) continue;
      const reason = typeof s[key] === 'string' ? unsafePatternReason(s[key] as string) : t('not a valid regular expression');
      if (reason) problems.push(t('{field}: {reason}', { field: key, reason }));
    }
    const hours = s.minIntervalHours;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 1 || hours > 168) problems.push(t('minIntervalHours must be between 1 and 168'));
    const bytes = s.maxBytes;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < MIN_BYTES || bytes > MAX_BYTES)
      problems.push(t('maxBytes must be a whole number between {min} and {max}', { min: MIN_BYTES, max: MAX_BYTES }));
    if (typeof s.enabled !== 'boolean') problems.push(t('enabled must be true or false'));
    if (problems.length) {
      errors.push(t('Source {id}: {problems}', { id: label, problems: problems.join('; ') }));
      return;
    }
    ids.add(id!);
    sources.push({
      id: id!,
      vendor: vendor!,
      product: product!,
      kind: kind!,
      url: url!.href,
      ...(homepage ? { homepage } : {}),
      allowHosts,
      ...(typeof s.stable === 'string' ? { stable: s.stable } : {}),
      ...(typeof s.titleFilter === 'string' ? { titleFilter: s.titleFilter } : {}),
      minIntervalHours: hours as number,
      maxBytes: bytes as number,
      enabled: s.enabled as boolean,
    });
  });
  return { sources, errors };
}
