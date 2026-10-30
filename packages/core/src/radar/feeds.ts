import { createHash } from 'node:crypto';
import { htmlToText } from '../tools/WebTools';
import { DEFAULT_STABLE_TAG } from './sources';
import type { RadarEntry, RadarSource } from './types';

/** Entry text kept for the model; release notes longer than this are cut. */
export const ENTRY_TEXT_MAX = 12_000;
const TITLE_MAX = 200;
/** A feed lists the newest entries first; older ones beyond this are not read. */
const MAX_FEED_ENTRIES = 200;
/** Tags and titles are cut before a source's own pattern runs on them. */
const TAG_MAX = 100;
const FILTER_TITLE_MAX = 300;
/** Tags this long are attribute soup, not markup worth reading. */
const MAX_TAG_SOURCE = 4_096;

/** sha256(sourceId|guid|tag) as hex: the same release keeps its id when its text is edited. */
export function entryId(sourceId: string, guid: string, tag = ''): string {
  return createHash('sha256').update(`${sourceId}|${guid}|${tag}`).digest('hex');
}

/**
 * The entries of a fetched feed, newest first, after the source's title filter and stable-tag
 * filter. Never throws: a malformed feed yields the entries that could be read. `truncated`
 * (the body was cut at maxBytes) drops a markdown section that may be incomplete; a cut XML
 * entry has no end tag and is never read.
 */
export function parseFeed(source: RadarSource, body: string, opts: { truncated?: boolean } = {}): RadarEntry[] {
  let stable: RegExp;
  let titleFilter: RegExp | undefined;
  try {
    stable = new RegExp(source.stable ?? DEFAULT_STABLE_TAG);
    titleFilter = source.titleFilter !== undefined ? new RegExp(source.titleFilter, 'i') : undefined;
  } catch {
    return []; // validateSources refuses these; without its filters a source cannot be read safely
  }
  const raw = source.kind === 'markdown' ? markdownEntries(body, opts.truncated === true) : xmlEntries(body);
  const links = new Set(source.allowHosts);
  const entries: RadarEntry[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    const title = oneLine(source.kind === 'markdown' ? `${source.product} ${r.title}` : r.title).slice(0, TITLE_MAX) || r.tag || '';
    if (!title || !r.guid) continue;
    if (titleFilter && !titleFilter.test(title.slice(0, FILTER_TITLE_MAX))) continue;
    if (r.tag !== undefined && (r.tag.length > TAG_MAX || !stable.test(r.tag))) continue;
    const id = entryId(source.id, r.guid.slice(0, 500), r.tag);
    if (ids.has(id)) continue;
    ids.add(id);
    const url = linkOn(r.link ?? (source.kind === 'markdown' ? source.homepage : undefined), links);
    entries.push({
      id,
      sourceId: source.id,
      vendor: source.vendor,
      product: source.product,
      title,
      ...(r.tag !== undefined ? { tag: r.tag } : {}),
      ...(url ? { url } : {}),
      ...(r.published ? { published: r.published } : {}),
      text: cleanBody(r.text),
    });
  }
  return entries;
}

interface RawEntry {
  guid: string;
  title: string;
  tag?: string;
  link?: string;
  published?: string;
  text: string;
}

// ------------------------------------------------------------------ Atom and RSS

interface Child {
  attrs: string;
  inner: string;
}

/**
 * Atom <entry> and RSS <item> elements as maps of their direct children (lowercase qualified
 * name -> occurrences). One forward pass over the document: every character is looked at a
 * constant number of times, and CDATA sections and comments are skipped whole, so markup inside
 * them is never taken for tags. An unclosed construct ends the scan.
 */
function scanEntries(xml: string): Array<Map<string, Child[]>> {
  const out: Array<Map<string, Child[]>> = [];
  let entry: Map<string, Child[]> | undefined;
  let depth = 0;
  let child: { name: string; attrs: string; start: number } | undefined;
  const n = xml.length;
  let pos = 0;
  while (pos < n && out.length < MAX_FEED_ENTRIES) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }
    if (xml[lt + 1] === '!' || xml[lt + 1] === '?') {
      const end = xml.indexOf('>', lt + 2);
      if (end === -1) break;
      pos = end + 1;
      continue;
    }
    const closing = xml[lt + 1] === '/';
    let i = lt + (closing ? 2 : 1);
    const nameStart = i;
    while (i < n && isNameChar(xml.charCodeAt(i))) i++;
    if (i === nameStart) {
      pos = lt + 1; // a lone "<" in text
      continue;
    }
    const name = xml.slice(nameStart, i).toLowerCase();
    // The end of the tag, skipping ">" inside quoted attribute values.
    let quote = 0;
    let j = i;
    for (; j < n; j++) {
      const c = xml.charCodeAt(j);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 0x22 || c === 0x27) quote = c;
      else if (c === 0x3e) break;
    }
    if (j >= n) break;
    pos = j + 1;
    const selfClosing = !closing && xml.charCodeAt(j - 1) === 0x2f;
    const attrs = j - i > MAX_TAG_SOURCE ? '' : xml.slice(i, selfClosing ? j - 1 : j);
    const local = name.slice(name.indexOf(':') + 1);
    if (!entry) {
      if (!closing && !selfClosing && (local === 'entry' || local === 'item')) {
        entry = new Map();
        depth = 0;
        child = undefined;
      }
      continue;
    }
    if (closing) {
      if (depth === 0) {
        if (local === 'entry' || local === 'item') {
          out.push(entry);
          entry = undefined;
        }
        continue;
      }
      depth--;
      if (depth === 0 && child) {
        add(entry, child.name, { attrs: child.attrs, inner: xml.slice(child.start, lt) });
        child = undefined;
      }
    } else if (depth === 0) {
      if (selfClosing) add(entry, name, { attrs, inner: '' });
      else {
        child = { name, attrs, start: pos };
        depth = 1;
      }
    } else if (!selfClosing) depth++;
  }
  return out;
}

function add(map: Map<string, Child[]>, name: string, child: Child): void {
  const list = map.get(name);
  if (list) {
    if (list.length < 20) list.push(child);
  } else map.set(name, [child]);
}

function isNameChar(c: number): boolean {
  // A-Z a-z 0-9 _ : . -
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x3a || c === 0x2e || c === 0x2d;
}

/** One attribute value from a tag's attribute text, entities decoded. */
function attr(attrs: string, name: string): string | undefined {
  // Plain scanning: the attribute text is untrusted and a regex here would rescan runs of word characters.
  const lower = attrs.toLowerCase();
  for (let from = 0; ; ) {
    const at = lower.indexOf(name, from);
    if (at === -1) return undefined;
    from = at + name.length;
    const before = at === 0 ? ' ' : lower[at - 1];
    if (!/\s/.test(before)) continue;
    let i = from;
    while (i < attrs.length && /\s/.test(attrs[i])) i++;
    if (attrs[i] !== '=') continue;
    i++;
    while (i < attrs.length && /\s/.test(attrs[i])) i++;
    const quote = attrs[i];
    if (quote !== '"' && quote !== "'") continue;
    const end = attrs.indexOf(quote, i + 1);
    if (end === -1) return undefined;
    return decodeXml(attrs.slice(i + 1, end));
  }
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** XML's five entities and numeric references. */
function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g, (match, code: string) => {
    if (code[0] !== '#') return XML_ENTITIES[code];
    const n = code[1] === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
  });
}

/** An element's character data: CDATA sections as they are, the rest entity-decoded. */
function elementText(inner: string): string {
  let out = '';
  for (let pos = 0; ; ) {
    const start = inner.indexOf('<![CDATA[', pos);
    if (start === -1) return out + decodeXml(inner.slice(pos));
    out += decodeXml(inner.slice(pos, start));
    const end = inner.indexOf(']]>', start + 9);
    if (end === -1) return out + inner.slice(start + 9);
    out += inner.slice(start + 9, end);
    pos = end + 3;
  }
}

const first = (entry: Map<string, Child[]>, ...names: string[]): Child | undefined => {
  for (const name of names) {
    const found = entry.get(name)?.[0];
    if (found) return found;
  }
  return undefined;
};

/** The text of a child that may hold HTML (Atom type="html"/"xhtml", RSS descriptions). */
function richText(child: Child | undefined, html: boolean): string {
  if (!child) return '';
  // Far more than any entry keeps; bounds the HTML conversion of a hostile feed.
  const text = elementText(child.inner.slice(0, ENTRY_TEXT_MAX * 20));
  const type = attr(child.attrs, 'type')?.toLowerCase();
  return html || type === 'html' || type === 'xhtml' || type === 'text/html' ? htmlToText(text).text : text;
}

function xmlEntries(xml: string): RawEntry[] {
  const out: RawEntry[] = [];
  for (const entry of scanEntries(xml)) {
    const atom = entry.has('id') || entry.has('updated') || entry.has('published');
    const link = atomLink(entry) ?? (entry.get('link')?.[0] ? oneLine(elementText(entry.get('link')![0].inner)) : undefined);
    const titleChild = first(entry, 'title');
    const title = titleChild ? oneLine(richText(titleChild, false)) : '';
    const guidChild = first(entry, 'id', 'guid');
    const dateChild = first(entry, 'published', 'updated', 'pubdate', 'dc:date');
    const published = dateChild ? isoDate(elementText(dateChild.inner)) : undefined;
    const guid = (guidChild && oneLine(elementText(guidChild.inner))) || link || (title && published ? `${title}|${published}` : '');
    const text = atom ? richText(first(entry, 'content', 'summary'), false) : richText(first(entry, 'content:encoded', 'description'), true);
    out.push({ guid, title, tag: releaseTag(link, guid), link, published, text });
  }
  return out;
}

/** The entry's alternate link (Atom <link href>, also used inside some RSS feeds). */
function atomLink(entry: Map<string, Child[]>): string | undefined {
  for (const name of ['link', 'atom:link']) {
    for (const child of entry.get(name) ?? []) {
      const href = attr(child.attrs, 'href');
      const rel = attr(child.attrs, 'rel') ?? 'alternate';
      if (href && rel === 'alternate') return href.trim();
    }
  }
  return undefined;
}

/** The release tag of a GitHub release, from its link or its Atom id. */
function releaseTag(link: string | undefined, guid: string): string | undefined {
  const fromLink = link ? /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\/([^?#]+)$/.exec(link)?.[1] : undefined;
  const fromId = /^tag:github\.com,2008:Repository\/\d+\/(.+)$/.exec(guid)?.[1];
  const raw = fromLink ?? fromId;
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ------------------------------------------------------------------ markdown changelogs

/** "## 1.2.3", "## [1.2.3] - 2026-10-30", "## v1.2.3 (2026-10-30)". */
const VERSION_HEADING = /^##[ \t]+\[?v?(\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.]{1,40})?)\]?(.*)$/;
const ISO_DAY = /\b(\d{4}-\d{2}-\d{2})\b/;

/** A CHANGELOG.md split into one entry per "## x.y.z" section (any other "## " heading ends a section). */
function markdownEntries(markdown: string, truncated: boolean): RawEntry[] {
  const out: RawEntry[] = [];
  let current: { version: string; published?: string; lines: string[]; size: number } | undefined;
  const close = () => {
    if (current) out.push({ guid: current.version, title: current.version, tag: current.version, published: current.published, text: current.lines.join('\n').trim() });
    current = undefined;
  };
  let pos = 0;
  while (pos <= markdown.length && out.length < MAX_FEED_ENTRIES) {
    let end = markdown.indexOf('\n', pos);
    if (end === -1) end = markdown.length;
    const line = markdown.slice(pos, end).replace(/\r$/, '');
    pos = end + 1;
    if (line.startsWith('##') && line[2] !== '#') {
      close();
      const m = VERSION_HEADING.exec(line.slice(0, 300));
      if (m) {
        const day = ISO_DAY.exec(m[2])?.[1];
        current = { version: m[1], lines: [], size: 0, published: day ? isoDate(day) : undefined };
      }
    } else if (current && current.size < ENTRY_TEXT_MAX * 2) {
      current.lines.push(line);
      current.size += line.length + 1;
    }
  }
  // A cut-off file may have cut the last section short; it comes back whole next time.
  if (truncated) current = undefined;
  close();
  return out;
}

// ------------------------------------------------------------------ helpers

/** "Wed, 30 Oct 2026 10:00:00 GMT" or ISO 8601 -> ISO; anything else -> undefined. */
function isoDate(text: string): string | undefined {
  const raw = text.trim().slice(0, 64);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

function oneLine(text: string): string {
  return text.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
}

function cleanBody(text: string): string {
  // Per line rather than /[ \t]+\n/, which rescans long runs of spaces from every start position.
  const cut = text.length > ENTRY_TEXT_MAX * 2 ? text.slice(0, ENTRY_TEXT_MAX * 2) : text;
  const clean = cut
    .replace(CONTROL, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean.length > ENTRY_TEXT_MAX ? `${clean.slice(0, ENTRY_TEXT_MAX - 1)}…` : clean;
}

/** An https link on one of the given hosts, normalized; anything else is dropped. */
function linkOn(raw: string | undefined, hosts: Set<string>): string | undefined {
  if (!raw || raw.length > 1_000) return undefined;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' && !url.username && !url.password && hosts.has(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
