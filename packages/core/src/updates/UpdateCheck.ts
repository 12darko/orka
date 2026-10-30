/**
 * Whether a newer Orka release is out: one request to GitHub's "latest release" endpoint. It only
 * tells; nothing is downloaded or installed. Callers decide how often to ask (once a day) and keep
 * the ETag, so an unchanged answer is a 304 that GitHub does not count against the rate limit.
 */

export const LATEST_RELEASE_API = 'https://api.github.com/repos/12darko/orka/releases/latest';
const RELEASE_PAGE = 'https://github.com/12darko/orka/releases/tag/';
const TIMEOUT_MS = 10_000;
/** A release answer is a few KB; anything this big is not one. */
const MAX_BODY_BYTES = 1_000_000;
/** The only tags that get a link: plain stable versions. */
const RELEASE_TAG = /^v?\d+\.\d+\.\d+$/;
/** x.y.z with an optional pre-release and build part (semver), "v" allowed in front. */
const SEMVER = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
/** A strong or weak ETag as GitHub sends it; anything else is neither stored nor sent back. */
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;

export interface UpdateCheckOptions {
  /** The running version (VERSION from the core). */
  currentVersion: string;
  /** The ETag of the previous answer: an unchanged release then comes back as `not_modified`. */
  etag?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Default 10 s. */
  timeoutMs?: number;
}

export interface UpdateCheckResult {
  /** `not_modified`: same answer as the one with `etag`; `error`: try again later. */
  status: 'newer' | 'current' | 'not_modified' | 'error';
  /** The latest stable version, without the "v". */
  latest?: string;
  /** Its release page, built from the checked tag (never taken from the answer). */
  url?: string;
  /** Pass back as `etag` next time. */
  etag?: string;
  error?: string;
}

/** Ask GitHub for the latest Orka release and compare it with `currentVersion`. Never throws. */
export async function checkAppUpdate(opts: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `Orka/${opts.currentVersion.replace(/[^\w.+-]/g, '') || 'unknown'}`,
  };
  const sentEtag = opts.etag && ETAG.test(opts.etag) ? opts.etag : undefined;
  if (sentEtag) headers['If-None-Match'] = sentEtag;
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, { headers, signal });
    if (response.status === 304 && sentEtag) {
      await response.body?.cancel().catch(() => {});
      return { status: 'not_modified', etag: sentEtag };
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return { status: 'error', error: `GitHub answered ${response.status}` };
    }
    const received = response.headers.get('etag') ?? undefined;
    const etag = received && ETAG.test(received) ? received : undefined;
    const body = await readCapped(response, MAX_BODY_BYTES);
    if (body === undefined) return { status: 'error', error: 'The answer is too large.' };
    const release: unknown = JSON.parse(body);
    if (!release || typeof release !== 'object') return { status: 'error', error: 'Unexpected answer.' };
    const { tag_name: tag, draft, prerelease } = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
    if (typeof tag !== 'string') return { status: 'error', error: 'The release has no tag.' };
    // Drafts and pre-releases are never offered; with nothing newer to offer, this is "current".
    if (draft === true || prerelease === true) return { status: 'current', etag };
    const version = parseVersion(tag);
    if (!version) return { status: 'error', error: 'Unexpected release tag.' };
    if (version.pre !== undefined || !RELEASE_TAG.test(tag)) return { status: 'current', etag };
    const latest = tag.replace(/^v/, '');
    return { status: isNewerVersion(latest, opts.currentVersion) ? 'newer' : 'current', latest, url: releasePageUrl(tag), etag };
  } catch (error) {
    if (opts.signal?.aborted) return { status: 'error', error: 'Cancelled.' };
    if (timeout.aborted) return { status: 'error', error: `Timed out after ${(opts.timeoutMs ?? TIMEOUT_MS) / 1000}s.` };
    const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
    return { status: 'error', error: cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/** The release page of a stable tag ("v1.2.3" or "1.2.3"); undefined for anything else. */
export function releasePageUrl(tag: string): string | undefined {
  return RELEASE_TAG.test(tag) ? `${RELEASE_PAGE}${tag}` : undefined;
}

/**
 * Whether `candidate` is a stable release newer than `current` (semver order: numbers first,
 * then a release beats a pre-release of the same numbers). A pre-release candidate never is.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || a.pre !== undefined || !b) return false;
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i];
  return b.pre !== undefined;
}

function parseVersion(text: string): { numbers: number[]; pre?: string } | undefined {
  const m = SEMVER.exec(text.trim());
  return m ? { numbers: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : undefined;
}

/** The body as text, or undefined when it is larger than `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<string | undefined> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
