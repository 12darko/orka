// End-to-end tests of the desktop app (dist/orka-desktop.js): the real app runs with --no-window
// and a real headless Edge/Chrome drives its UI, while a fake Claude API scripts the model's turns.
// Everything else is real: the shared controller, the local server and its security checks,
// in-app dialogs, file writes, task history and (on Windows) DPAPI-protected API keys.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

  /** Start the app without a window; resolves with its start URL. `node` is put before the app on Node's command line. */
  function launch(folder = work, { node = [], env = {} } = {}) {
    app = spawn(process.execPath, [...node, APP, folder, '--no-window'], {
      // No update check against GitHub from tests.
      env: { ...process.env, ORKA_HOME: home, ORKA_DEBUG: '1', ORKA_NO_UPDATE_CHECK: '1', ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'test-key-for-fake-server', ...env },
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

  it('lists sessions on the left, reopens one, and follows the theme and layout settings', async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    assert.equal(await browser.evaluate('document.documentElement.dataset.layout'), 'ide');
    assert.equal(await browser.evaluate('!!document.querySelector("#sidebar:not([hidden]) .side-new")'), true, 'the session list is shown');
    // Closed, the list becomes a rail of icons, and the conversation still fills the window.
    await browser.clickSelector('.side-head [data-action="toggle-sidebar"]');
    await until(() => browser.evaluate('document.querySelector("#sidebar").classList.contains("collapsed")'), 'the rail');
    assert.equal(await browser.evaluate('document.querySelector(".main-col").getBoundingClientRect().width > innerWidth - 160'), true, 'the conversation fills the window');
    await browser.clickSelector('.side-rail [data-action="toggle-sidebar"]');
    await until(() => browser.evaluate('!document.querySelector("#sidebar").classList.contains("collapsed")'), 'the list again');

    script = [() => reply('All set.')];
    await browser.clickSelector('#input');
    await browser.type('Tidy up the readme');
    await browser.clickSelector('#send');
    await until(async () => (await text()).includes('All set.'), 'the reply');
    // Saved when the request finished, then listed under its folder.
    const id = await until(() => browser.evaluate('document.querySelector(".side-item .side-open[data-id]")?.dataset.id'), 'the saved session');
    assert.match(await browser.evaluate('document.querySelector("#side-list").textContent'), /Tidy up the readme/);
    assert.equal(await browser.evaluate(`document.querySelector('.side-open[data-id="${id}"]').closest('.side-item').classList.contains('current')`), true);

    await browser.clickSelector('.side-new');
    await until(async () => !(await text()).includes('All set.'), 'a new session');
    await browser.clickSelector(`.side-open[data-id="${id}"]`);
    await until(async () => (await text()).includes('All set.'), 'the session reopened');

    await browser.clickSelector('#theme-switch [data-value="light"]');
    await until(async () => (await browser.evaluate('document.documentElement.dataset.theme')) === 'light', 'the light theme');
    assert.equal(JSON.parse(readFileSync(path.join(home, 'desktop', 'settings.json'), 'utf8'))['desktop.theme'], 'light');

    // The layout is chosen as the page loads: changing it reloads the window once.
    assert.equal(await post({ type: 'setSetting', key: 'desktop.layout', value: 'classic' }), 204);
    await until(async () => (await browser.evaluate('document.documentElement.dataset.layout').catch(() => undefined)) === 'classic', 'the classic layout');
    await until(async () => (await text()).includes('All set.'), 'the chat after the reload');
    assert.equal(await browser.evaluate('!!document.querySelector("#sidebar")'), false);
    assert.equal(await browser.evaluate('document.documentElement.dataset.theme'), 'light', 'the theme stays');
  });

  it('shows Radar in a tab next to the plan and changes: off, naming every site it would contact, fetching nothing', async () => {
    // Every fetch the app makes is written down.
    const probe = path.join(home, 'fetch-probe.cjs');
    const fetchLog = path.join(home, 'fetches.log');
    writeFileSync(
      probe,
      `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(fetchLog)}, 'probe loaded\\n');
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  fs.appendFileSync(${JSON.stringify(fetchLog)}, (typeof input === 'string' ? input : input.url ?? String(input)) + '\\n');
  return real(input, init);
};
`,
    );
    const url = await launch(work, { node: ['--require', probe] });
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    // A new session has no plan or changes: the side panel opens on Radar.
    await until(() => browser.evaluate('!!document.querySelector(".topbar .aside-btn")'), 'the side panel switch');
    assert.equal(await browser.evaluate('document.querySelector("#aside").hidden'), true, 'closed until asked for');
    await browser.clickSelector('.topbar .aside-btn');
    await until(() => browser.evaluate('!document.querySelector("#radar-panel").hidden'), 'the Radar tab');
    assert.equal(await browser.evaluate('document.querySelector("#aside-tab-radar").getAttribute("aria-selected")'), 'true');
    assert.equal(await browser.evaluate('document.querySelector("#aside-tab-task").disabled'), true, 'no plan or changes to show yet');
    const panel = await browser.evaluate('document.querySelector("#radar-panel").textContent');
    assert.match(panel, /It is off: nothing is fetched\./);
    const hosts = await browser.evaluate('[...document.querySelectorAll("#radar-panel .radar-hosts code")].map((c) => c.textContent)');
    assert.deepEqual(
      [...hosts].sort(),
      ['code.visualstudio.com', 'cursor.com', 'github.blog', 'github.com', 'kiro.dev', 'learn.chatgpt.com', 'raw.githubusercontent.com', 'www.cursor.com'],
    );
    assert.equal(await browser.evaluate('!!document.querySelector("#radar-panel [data-action=radar-switch][data-on=true]")'), true, 'turning it on is a click away');
    // The session list offers it too (and its rail, when closed).
    assert.equal(await browser.evaluate('!!document.querySelector("#side-radar [data-action=open-radar]")'), true);

    // Nothing was fetched from any of them, and Radar wrote nothing.
    await sleep(1500);
    const [loaded, ...fetched] = readFileSync(fetchLog, 'utf8').split('\n').filter(Boolean);
    assert.equal(loaded, 'probe loaded', 'the app ran with the probe');
    assert.deepEqual(
      fetched.filter((u) => hosts.includes(new URL(u).hostname)),
      [],
    );
    assert.equal(existsSync(path.join(home, 'radar')), false);
    assert.equal(JSON.parse(readFileSync(path.join(home, 'desktop', 'settings.json'), 'utf8'))['radar.enabled'], undefined);
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
    // Its code is visible on the browser's command line, so it works only once.
    assert.equal(await get(new URL(url).pathname + new URL(url).search), 403, 'the start URL is single-use');
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

describe('Orka desktop process', { skip: (process.platform !== 'win32' && 'Windows-only') || (!existsSync(APP) && 'build first (npm run build -w orka-desktop)') }, () => {
  it('sets up its own process at start: nothing it or its children start by bare name comes from the current folder', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orka-lookup-'));
    try {
      // Loaded before the app; reports the variable as the app leaves it.
      const probe = path.join(dir, 'probe.cjs');
      writeFileSync(probe, "process.on('exit', () => process.stderr.write(`lookup=${process.env.NoDefaultCurrentDirectoryInExePath}\\n`));\n");
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete env[key];
      const run = spawnSync(process.execPath, ['--require', probe, APP, '--version'], { cwd: dir, env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stderr, /lookup=1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// orka-desktop.exe is a windowed program on Windows: started from Explorer it has no console, so
// the log file is where a failed start can be read.
describe('Orka desktop log', { skip: !existsSync(APP) && 'build first (npm run build -w orka-desktop)' }, () => {
  it('records a failed start in desktop.log', async () => {
    const busy = http.createServer();
    await new Promise((r) => busy.listen(0, '127.0.0.1', r));
    const home = mkdtempSync(path.join(tmpdir(), 'orka-desktop-home-'));
    try {
      const app = spawn(process.execPath, [APP, '--no-window', '--port', String(busy.address().port)], {
        env: { ...process.env, ORKA_HOME: home, ORKA_NO_UPDATE_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      app.stderr.on('data', (c) => (stderr += c));
      const code = await new Promise((r) => app.once('exit', r));
      assert.equal(code, 1, stderr);
      assert.match(stderr, /EADDRINUSE/);
      const log = readFileSync(path.join(home, 'desktop', 'desktop.log'), 'utf8');
      assert.match(log, /Orka Desktop \S+ starting/);
      assert.match(log, /Could not start: Error: listen EADDRINUSE/);
    } finally {
      busy.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
