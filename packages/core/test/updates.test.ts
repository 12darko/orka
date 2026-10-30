import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAppUpdate, isNewerVersion, LATEST_RELEASE_API, releasePageUrl } from '../src/updates/UpdateCheck';

type Call = { url: string; headers: Headers };

/** A fetch that records each request and answers with `respond` (no network). */
function fakeFetch(respond: (call: Call, init: RequestInit) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), headers: new Headers(init.headers) };
    calls.push(call);
    return respond(call, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const release = (fields: Record<string, unknown>, etag = 'W/"abc123"') =>
  fakeFetch(() => new Response(JSON.stringify({ draft: false, prerelease: false, html_url: 'https://evil.example/download', ...fields }), { status: 200, headers: { etag } }));

describe('Update check', () => {
  it('reports a newer release with a link built from the tag, never from html_url', async () => {
    const { fetchImpl, calls } = release({ tag_name: 'v0.2.0' });
    const result = await checkAppUpdate({ currentVersion: '0.1.1', fetchImpl });
    assert.deepEqual(result, { status: 'newer', latest: '0.2.0', url: 'https://github.com/12darko/orka/releases/tag/v0.2.0', etag: 'W/"abc123"' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, LATEST_RELEASE_API);
    assert.equal(calls[0].headers.get('accept'), 'application/vnd.github+json');
    assert.equal(calls[0].headers.get('user-agent'), 'Orka/0.1.1');
    assert.equal(calls[0].headers.get('if-none-match'), null, 'no ETag yet');
  });

  it('is current on the same version and on an older one', async () => {
    assert.equal((await checkAppUpdate({ currentVersion: '0.1.1', fetchImpl: release({ tag_name: 'v0.1.1' }).fetchImpl })).status, 'current');
    const older = await checkAppUpdate({ currentVersion: '0.3.0', fetchImpl: release({ tag_name: 'v0.2.9' }).fetchImpl });
    assert.equal(older.status, 'current');
    assert.equal(older.latest, '0.2.9');
    assert.equal((await checkAppUpdate({ currentVersion: '0.9.0', fetchImpl: release({ tag_name: '0.10.0' }).fetchImpl })).status, 'newer', 'numbers compare as numbers');
  });

  it('sends the ETag back and reports an unchanged release as not_modified', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 304 }));
    const result = await checkAppUpdate({ currentVersion: '0.1.1', etag: '"abc123"', fetchImpl });
    assert.deepEqual(result, { status: 'not_modified', etag: '"abc123"' });
    assert.equal(calls[0].headers.get('if-none-match'), '"abc123"');

    // A malformed ETag (e.g. a hand-edited state file) is not sent, so a 304 cannot answer it.
    const bad = fakeFetch(() => new Response(null, { status: 304 }));
    assert.equal((await checkAppUpdate({ currentVersion: '0.1.1', etag: 'abc\r\nX-Evil: 1', fetchImpl: bad.fetchImpl })).status, 'error');
    assert.equal(bad.calls[0].headers.get('if-none-match'), null);
  });

  it('never offers drafts, pre-releases or tags it cannot read', async () => {
    for (const fields of [{ tag_name: 'v9.0.0', prerelease: true }, { tag_name: 'v9.0.0', draft: true }, { tag_name: 'v9.0.0-beta.1' }]) {
      const result = await checkAppUpdate({ currentVersion: '0.1.1', fetchImpl: release(fields).fetchImpl });
      assert.equal(result.status, 'current', JSON.stringify(fields));
      assert.equal(result.url, undefined);
    }
    for (const tag of ['nightly', 'v1.2', '1.2.3; rm -rf /', '../../evil/v1.2.3', 42]) {
      const result = await checkAppUpdate({ currentVersion: '0.1.1', fetchImpl: release({ tag_name: tag }).fetchImpl });
      assert.equal(result.status, 'error', String(tag));
      assert.equal(result.url, undefined);
    }
    const notJson = fakeFetch(() => new Response('<html>rate limited</html>', { status: 200 }));
    assert.equal((await checkAppUpdate({ currentVersion: '0.1.1', fetchImpl: notJson.fetchImpl })).status, 'error');
  });

  it('treats any other status as an error', async () => {
    for (const status of [403, 404, 500]) {
      const result = await checkAppUpdate({ currentVersion: '0.1.1', fetchImpl: fakeFetch(() => new Response('{}', { status })).fetchImpl });
      assert.deepEqual(result, { status: 'error', error: `GitHub answered ${status}` });
    }
    // A 304 without an ETag sent is not a valid answer either.
    assert.equal((await checkAppUpdate({ currentVersion: '0.1.1', fetchImpl: fakeFetch(() => new Response(null, { status: 304 })).fetchImpl })).status, 'error');
  });

  it('stops reading an oversized answer', async () => {
    const declared = fakeFetch(() => new Response('{"tag_name":"v9.9.9"}', { status: 200, headers: { 'content-length': '5000000' } }));
    assert.deepEqual(await checkAppUpdate({ currentVersion: '0.1.1', fetchImpl: declared.fetchImpl }), { status: 'error', error: 'The answer is too large.' });

    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 64_000;
        controller.enqueue(new Uint8Array(64_000).fill(0x20));
      },
    });
    const streamed = fakeFetch(() => new Response(endless, { status: 200 }));
    assert.deepEqual(await checkAppUpdate({ currentVersion: '0.1.1', fetchImpl: streamed.fetchImpl }), { status: 'error', error: 'The answer is too large.' });
    assert.ok(sent < 1_200_000, `read ${sent} bytes`);
  });

  it('gives up after the timeout, and when the caller cancels', async () => {
    // A server that never answers; the timer stands in for its open socket (the timeout's own timer does not keep Node running).
    const hang = fakeFetch(
      (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          const socket = setTimeout(() => reject(new Error('the timeout did not fire')), 10_000);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(socket);
            reject(init.signal!.reason);
          });
        }),
    );
    const started = Date.now();
    const timedOut = await checkAppUpdate({ currentVersion: '0.1.1', fetchImpl: hang.fetchImpl, timeoutMs: 50 });
    assert.equal(timedOut.status, 'error');
    assert.match(timedOut.error ?? '', /Timed out/);
    assert.ok(Date.now() - started < 5000);

    const controller = new AbortController();
    const pending = checkAppUpdate({ currentVersion: '0.1.1', fetchImpl: hang.fetchImpl, signal: controller.signal });
    controller.abort();
    assert.deepEqual(await pending, { status: 'error', error: 'Cancelled.' });
  });

  it('reports a network error without throwing', async () => {
    const offline = fakeFetch(() => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })));
    assert.deepEqual(await checkAppUpdate({ currentVersion: '0.1.1', fetchImpl: offline.fetchImpl }), { status: 'error', error: 'ENOTFOUND' });
  });

  it('compares versions the semver way', () => {
    assert.equal(isNewerVersion('0.2.0', '0.1.1'), true);
    assert.equal(isNewerVersion('v1.0.0', '0.99.99'), true);
    assert.equal(isNewerVersion('0.2.0', '0.2.0-dev'), true, 'a release beats its own pre-release');
    assert.equal(isNewerVersion('0.2.0', '0.2.0'), false);
    assert.equal(isNewerVersion('0.1.9', '0.2.0'), false);
    assert.equal(isNewerVersion('0.3.0-rc.1', '0.2.0'), false, 'a pre-release never counts as newer');
    assert.equal(isNewerVersion('latest', '0.1.0'), false);
    assert.equal(isNewerVersion('0.2.0', 'garbage'), false);
    assert.equal(releasePageUrl('v0.2.0'), 'https://github.com/12darko/orka/releases/tag/v0.2.0');
    assert.equal(releasePageUrl('v0.2.0/../../evil'), undefined);
  });
});
