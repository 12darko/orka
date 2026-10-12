// End-to-end tests of the desktop app (dist/orka-desktop.js): the real app runs with --no-window
// and a real headless Edge/Chrome drives its UI, while a fake Claude API scripts the model's turns.
// Everything else is real: the shared controller, the local server and its security checks,
// in-app dialogs, file writes, task history and (on Windows) DPAPI-protected API keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'dist', 'orka-desktop.js');
const require = createRequire(import.meta.url);
const core = path.join(here, '..', '..', 'core', 'dist', 'src', 'browser', 'HeadlessBrowser.js');
const { HeadlessBrowser, findBrowser } = existsSync(core) ? require(core) : {};

const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const start = (id) => ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }];
const toolUse = (id, name, input) =>
  sse([
    start(`msg_${id}`),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
const reply = (text) =>
  sse([
    start('msg_text'),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

describe('Orka desktop app', { skip: (!existsSync(APP) && 'build first (npm run build -w orka-desktop)') || (!HeadlessBrowser && 'build the core package first') || (!findBrowser?.() && 'no Chrome/Edge installed') }, () => {
  let server;
  let baseURL;
  let script = [];
  let requests = [];
  let home;
  let work;
  let app;
  let browser;

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
          res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
          return;
        }
        const body = JSON.parse(raw);
        requests.push({ body, headers: req.headers });
        const next = script.shift();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(next ? next(body) : reply('(script ended)'));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseURL = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'orka-desktop-home-'));
    work = mkdtempSync(path.join(tmpdir(), 'orka-desktop-work-'));
    mkdirSync(path.join(home, 'desktop'), { recursive: true });
    writeFileSync(
      path.join(home, 'desktop', 'settings.json'),
      // A fixed provider and no background Claude Code updates in tests.
      JSON.stringify({ provider: 'claude', 'claude.model': 'claude-opus-5-5', 'supervisor.enabled': false, language: 'en', 'claudeCode.autoUpdate': false }),
    );
    requests = [];
    script = [];
    browser = new HeadlessBrowser();
  });
  afterEach(() => {
    browser.close();
    app?.kill();
    app = undefined;
  });

  /** What the running app printed (for failure messages). */
  let appOutput = '';

  /** Start the app without a window; resolves with its start URL. */
  function launch(folder = work) {
    app = spawn(process.execPath, [APP, folder, '--no-window'], {
      env: { ...process.env, ORKA_HOME: home, ORKA_DEBUG: '1', ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'test-key-for-fake-server' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    appOutput = '';
    app.stderr.on('data', (c) => (appOutput = out += c));
    return new Promise((resolve, reject) => {
      app.stdout.on('data', (c) => {
        appOutput = out += c;
        const url = /ORKA_DESKTOP_URL=(\S+)/.exec(out)?.[1];
        if (url) resolve(url);
      });
      app.once('exit', (code) => reject(new Error(`the app exited (${code}): ${out}`)));
    });
  }

  const text = async () => (await browser.text()).text;
  const post = (message) =>
    browser.evaluate(`fetch('/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(message))} }).then((r) => r.status)`);

  it('runs a task from its own UI, then reverts it through an in-app dialog', async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    assert.equal(await browser.evaluate('document.querySelector(".folder-btn span")?.textContent'), path.basename(work), 'the folder is shown');

    script = [
      () => toolUse('toolu_w', 'write_file', { path: 'notes/hello.txt', content: 'Hello from Orka Desktop\n' }),
      () => reply('Created notes/hello.txt for you.'),
    ];
    await browser.clickSelector('#input');
    await browser.type('Create a hello note');
    await browser.clickSelector('#send');
    await until(async () => (await text()).includes('Created notes/hello.txt for you.'), 'the reply');
    assert.equal(readFileSync(path.join(work, 'notes', 'hello.txt'), 'utf8'), 'Hello from Orka Desktop\n');
    assert.equal(requests[0].headers['x-api-key'], 'test-key-for-fake-server');
    assert.ok(requests[0].body.tools.some((t) => t.name === 'browser'));

    // "Revert all" asks first - inside the UI, since there is no VS Code to ask.
    await browser.clickSelector('[data-action="revert-all"]');
    await until(() => browser.evaluate('!!document.querySelector(".modal-backdrop .dialog")'), 'the confirmation dialog');
    assert.match(await text(), /Revert the 1 AI-changed file\?/);
    await browser.clickSelector('.modal-backdrop [data-action="dialog-action"]');
    await until(() => !existsSync(path.join(work, 'notes', 'hello.txt')), 'the revert');
    assert.equal(await browser.evaluate('!!document.querySelector(".modal-backdrop")'), false, 'the dialog closed');
  });

  it('switches folders from the UI and keeps a recent list', async () => {
    const other = mkdtempSync(path.join(tmpdir(), 'orka-desktop-other-'));
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    assert.equal(await post({ type: 'openFolder', path: other }), 204);
    await until(async () => (await browser.evaluate('document.querySelector(".folder-btn span")?.textContent')) === path.basename(other), 'the folder switch');
    const state = JSON.parse(readFileSync(path.join(home, 'desktop', 'state.json'), 'utf8'));
    assert.deepEqual(state.global.recentFolders.slice(0, 2), [path.resolve(other), path.resolve(work)]);
    rmSync(other, { recursive: true, force: true });
  });

  it('only lets its own window in', async () => {
    const url = await launch();
    const { port } = new URL(url);
    const get = (pathname, headers = {}) =>
      new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => resolve(res.statusCode)).on('error', () => resolve(0)));
    assert.equal(await get('/'), 403, 'no session cookie');
    assert.equal(await get('/?t=wrong'), 403, 'wrong token');
    assert.equal(await get(new URL(url).pathname + new URL(url).search, { host: `evil.example:${port}` }), 421, 'DNS rebinding');
    assert.equal(await get(new URL(url).pathname + new URL(url).search), 303, 'the start URL sets the cookie');
  });

  it('keeps API keys protected by the operating system', { skip: process.platform !== 'win32' && 'DPAPI check is Windows-only' }, async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    await post({ type: 'setApiKey', provider: 'openai' });
    await until(() => browser.evaluate('!!document.querySelector(".modal-backdrop .dialog-input")'), 'the key dialog');
    assert.equal(await browser.evaluate('document.querySelector(".dialog-input").type'), 'password');
    await browser.clickSelector('.dialog-input');
    await browser.type('sk-test-desktop-1234567890');
    await browser.press('Enter');
    const keys = path.join(home, 'desktop', 'keys.json');
    // Encrypting starts PowerShell, which can be slow on a fresh CI machine.
    await until(() => existsSync(keys), 'the stored key', 120_000).catch(async (error) => {
      throw new Error(`${error.message}\n--- UI ---\n${(await text()).slice(-2000)}\n--- app ---\n${appOutput.slice(-2000)}`);
    });
    const blob = JSON.parse(readFileSync(keys, 'utf8'))['orka.apiKey.openai'];
    assert.match(blob, /^[0-9a-f]{100,}$/i, 'encrypted, not the key itself');
    assert.doesNotMatch(readFileSync(keys, 'utf8'), /sk-test-desktop/);

    // A new app instance reads it back (Windows decrypts it for this user only).
    browser.close();
    app.kill();
    browser = new HeadlessBrowser();
    const again = await launch();
    await browser.navigate(again);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    await browser.clickSelector('[data-action="open-settings"]');
    await browser.clickSelector('[data-action="tab"][data-tab="providers"]');
    await until(async () => (await text()).includes('sk-tes••••7890'), 'the stored key hint', 120_000);
  });
});
