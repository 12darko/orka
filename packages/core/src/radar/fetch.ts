import { t } from '../i18n';
import { VERSION } from '../version';
import { isNeverFetched } from './sources';
import type { RadarSource } from './types';

export const RADAR_USER_AGENT = `OrkaRadar/${VERSION} (+https://github.com/12darko/orka)`;
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/** Requests to one host are at least this far apart (GitHub serves most of the feeds). */
const HOST_SPACING_MS = 1_000;
/** A strong or weak ETag as servers send it; anything else is neither stored nor sent back. */
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;
/** An HTTP date ("Wed, 21 Oct 2015 07:28:00 GMT"). */
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export interface RadarValidators {
  etag?: string;
  lastModified?: string;
}

export type RadarFetchResult =
  | { status: 'not_modified' }
  | { status: 'ok'; body: string; truncated: boolean; etag?: string; lastModified?: string; url: string }
  | { status: 'error'; error: string };

export interface RadarFetchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Default 30 s, for the whole request including the body. */
  timeoutMs?: number;
  pacer?: HostPacer;
}

/** Keeps requests to the same host apart. One pacer per radar, so the spacing holds across polls. */
export class HostPacer {
  private readonly next = new Map<string, number>();

  constructor(
    private readonly spacingMs = HOST_SPACING_MS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = delay,
  ) {}

  /** Wait for this host's turn. The slot is reserved before waiting, so parallel callers queue up. */
  async wait(host: string, signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + this.spacingMs);
    if (at > now) await this.sleep(at - now, signal);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Fetch one source with a conditional GET. HTTPS only; redirects are followed by hand and only
 * to the source's own hosts; the body is cut at `maxBytes`. Never throws.
 */
export async function fetchSource(source: RadarSource, validators: RadarValidators, opts: RadarFetchOptions = {}): Promise<RadarFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const headers: Record<string, string> = {
    'User-Agent': RADAR_USER_AGENT,
    Accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/markdown, text/plain;q=0.8, */*;q=0.5',
  };
  const etag = validators.etag && ETAG.test(validators.etag) ? validators.etag : undefined;
  const lastModified = validators.lastModified && HTTP_DATE.test(validators.lastModified) ? validators.lastModified : undefined;
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return { status: 'error', error: t('Not a valid URL.') };
  }
  try {
    for (let hop = 0; ; hop++) {
      const refused = refuse(source, url);
      if (refused) return { status: 'error', error: refused };
      await opts.pacer?.wait(url.hostname, signal);
      const response = await fetchImpl(url.href, { headers, signal, redirect: 'manual' });
      const location = response.status >= 300 && response.status < 400 && response.status !== 304 ? response.headers.get('location') : null;
      if (location !== null) {
        await response.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) return { status: 'error', error: t('Too many redirects.') };
        try {
          url = new URL(location, url);
        } catch {
          return { status: 'error', error: t('The server redirected to an invalid address.') };
        }
        continue;
      }
      if (response.status === 304) {
        await response.body?.cancel().catch(() => {});
        // A 304 answers only a conditional request; without one there is nothing it could mean.
        return etag || lastModified ? { status: 'not_modified' } : { status: 'error', error: t('The server answered {status}.', { status: 304 }) };
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return { status: 'error', error: t('The server answered {status}.', { status: response.status }) };
      }
      const receivedEtag = response.headers.get('etag') ?? undefined;
      const receivedDate = response.headers.get('last-modified') ?? undefined;
      const { text, truncated } = await readCapped(response, source.maxBytes);
      return {
        status: 'ok',
        body: text,
        truncated,
        url: url.href,
        ...(receivedEtag && ETAG.test(receivedEtag) ? { etag: receivedEtag } : {}),
        ...(receivedDate && HTTP_DATE.test(receivedDate) ? { lastModified: receivedDate } : {}),
      };
    }
  } catch (error) {
    if (opts.signal?.aborted) return { status: 'error', error: t('Cancelled.') };
    if (timeout.aborted) return { status: 'error', error: t('Timed out after {seconds}s.', { seconds: timeoutMs / 1000 }) };
    const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
    return { status: 'error', error: cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/** Why the radar must not request `url` for this source, or undefined. */
function refuse(source: RadarSource, url: URL): string | undefined {
  if (url.protocol !== 'https:') return t('Refused {url}: only HTTPS is allowed.', { url: url.href.slice(0, 200) });
  const host = url.hostname.toLowerCase();
  if (isNeverFetched(host)) return t('Refused {url}: this host is never fetched.', { url: url.href.slice(0, 200) });
  if (!source.allowHosts.includes(host)) return t('Refused a redirect to {host}: not one of the hosts allowed for this source.', { host: host.slice(0, 100) });
  if (url.username || url.password) return t('Refused {url}: addresses with credentials are not fetched.', { url: `${url.protocol}//${host}` });
  if (url.port) return t('Refused {url}: only the standard HTTPS port is allowed.', { url: url.href.slice(0, 200) });
  return undefined;
}

/** The body as text, cut at `maxBytes` (the rest is never downloaded). */
async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), truncated };
}
