// The daily update check of interactive sessions: the built dist/orka.js runs in this process with
// streams that act as a terminal, and fetch is replaced so GitHub is never really asked.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ORKA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'orka.js');
const DAY = 24 * 60 * 60 * 1000;
const NOTICE = 'Orka 99.0.0 is available: https://github.com/12darko/orka/releases/tag/v99.0.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

/** Streams that act as a terminal; `tty: false` makes stdout a pipe (input stays interactive). */
function terminal({ tty = true } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (mode) => {
    stdin.isRaw = mode;
    return stdin;
  };
  const stdout = new PassThrough();
  if (tty) stdout.isTTY = true;
  const stderr = new PassThrough();
  let text = '';
  stdout.on('data', (c) => (text += c));
  stderr.on('data', (c) => (text += c));
  return {
    io: { stdin, stdout, stderr },
    output: () => plain(text),
    type: (s) => stdin.write(s),
    async waitFor(pattern, timeout = 20_000) {
      const end = Date.now() + timeout;
      while (!plain(text).includes(pattern)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${pattern}\n--- output ---\n${plain(text)}`);
        await sleep(20);
      }
    },
  };
}

async function until(check, what, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe('orka CLI update check', { skip: !existsSync(ORKA) && 'build the CLI first (npm run build -w orka-agent)' }, () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orka-update-home-'));
  const stateFile = path.join(home, 'update-check.json');
  const configFile = path.join(home, 'config.json');
  const realFetch = globalThis.fetch;
  let calls = [];
  let answer;
  let main;
  let work;

  before(() => {
    Object.assign(process.env, { ORKA_HOME: home, ORKA_NO_CLIPBOARD: '1', NO_COLOR: '1', ANTHROPIC_API_KEY: 'test-key-never-sent' });
    delete process.env.ORKA_NO_UPDATE_CHECK;
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
      calls.push({ url, headers: new Headers(init?.headers) });
      return answer();
    };
    main = createRequire(import.meta.url)(ORKA).main;
  });
  after(() => {
    globalThis.fetch = realFetch;
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'orka-update-work-'));
    calls = [];
    answer = () => new Response(JSON.stringify({ tag_name: 'v99.0.0', draft: false, prerelease: false }), { status: 200, headers: { etag: '"r99"' } });
    rmSync(stateFile, { force: true });
    rmSync(configFile, { force: true });
    delete process.env.ORKA_NO_UPDATE_CHECK;
  });

  /** The saved state, or undefined while there is none (or it is being written). */
  const state = () => {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      return undefined;
    }
  };
  const saveState = (value) => writeFileSync(stateFile, JSON.stringify(value));
  const newer = (age) => ({ checkedAt: Date.now() - age, etag: '"r99"', latest: '99.0.0', url: 'https://github.com/12darko/orka/releases/tag/v99.0.0' });

  /** One session: start, let `during` run while it is open, then /exit. Returns everything it printed. */
  async function session(term, during = () => sleep(300)) {
    const done = main(['--lang', 'en', '--provider', 'claude', '--model', 'claude-opus-5-5', '--no-supervisor', '-C', work], term.io);
    await term.waitFor('/help for commands');
    await during();
    term.type('/exit\r');
    assert.equal(await done, 0);
    return term.output();
  }

  it('checks in the background, shows a newer release at the next start, and asks at most once a day', async () => {
    const first = await session(terminal(), () => until(() => state()?.latest, 'the saved answer'));
    assert.doesNotMatch(first, /is available/, 'nothing is known yet at the first start');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/repos/12darko/orka/releases/latest');
    assert.match(calls[0].headers.get('user-agent'), /^Orka\/\d+\.\d+\.\d+/);
    assert.equal(calls[0].headers.get('if-none-match'), null);
    assert.deepEqual({ ...state(), checkedAt: 0 }, { ...newer(0), checkedAt: 0 });

    // Same day: the saved answer is shown and GitHub is not asked again.
    const second = await session(terminal());
    assert.ok(second.includes(NOTICE), second);
    assert.equal(calls.length, 1, 'the cache is honoured');

    // A day later: asked again with the ETag; an unchanged release (304) keeps the saved answer.
    saveState(newer(DAY + 60_000));
    answer = () => new Response(null, { status: 304 });
    const third = await session(terminal(), () => until(() => calls.length === 2 && Date.now() - (state()?.checkedAt ?? 0) < DAY, 'the second check'));
    assert.ok(third.includes(NOTICE), 'shown from the saved answer while the check runs');
    assert.equal(calls[1].headers.get('if-none-match'), '"r99"');
    assert.equal(state().latest, '99.0.0');
  });

  it('says nothing about a release it already runs, or about a saved link it did not build', async () => {
    saveState({ ...newer(0), latest: '0.0.1', url: 'https://github.com/12darko/orka/releases/tag/v0.0.1' });
    assert.doesNotMatch(await session(terminal()), /is available/);
    saveState({ ...newer(0), url: 'https://evil.example/orka-99.0.0.exe' });
    assert.doesNotMatch(await session(terminal()), /is available/);
    assert.equal(calls.length, 0);
  });

  it('is off with ORKA_NO_UPDATE_CHECK=1 or "updateCheck": false', async () => {
    const stale = newer(2 * DAY);
    saveState(stale);
    process.env.ORKA_NO_UPDATE_CHECK = '1';
    assert.doesNotMatch(await session(terminal()), /is available/);
    delete process.env.ORKA_NO_UPDATE_CHECK;
    writeFileSync(configFile, JSON.stringify({ updateCheck: false }));
    assert.doesNotMatch(await session(terminal()), /is available/);
    assert.equal(calls.length, 0, 'GitHub is never asked');
    assert.deepEqual(state(), stale, 'and the saved state is left alone');
  });

  it('never checks or tells when stdout is not a terminal', async () => {
    const stale = newer(2 * DAY);
    saveState(stale);
    const output = await session(terminal({ tty: false }));
    assert.doesNotMatch(output, /is available/);
    assert.equal(calls.length, 0);
    assert.deepEqual(state(), stale);
  });
});
