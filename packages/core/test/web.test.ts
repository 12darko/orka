import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { NodeHost } from '../src/host/NodeHost';
import { PermissionManager } from '../src/permissions/PermissionManager';
import type { ToolContext } from '../src/tools/Tool';
import { htmlToText, isBlockedAddress, openBrowserTool, openFileTool, webFetchTool } from '../src/tools/WebTools';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { call, ScriptedProvider, tempWorkspace, text } from './helpers';

const PAGE = `<!doctype html><html><head><title>Fusion &amp; Lobbies</title><style>body{color:red}</style><script>alert(1)</script></head>
<body><nav><a href="/">Home</a> <a href="/docs">Docs</a></nav>
<main><h1>Player <em>Ready</em> State</h1><p>Use a <code>NetworkDictionary</code> for &quot;ready&quot; flags.
See <a href="/api/runner">the runner API</a> and <a href="#top">top</a>.</p>
<ul><li>One</li><li>Two &lt;three&gt;</li></ul>
<pre><code>if (ready)
    Start();</code></pre>
<table><tr><th>Name</th><th>Type</th></tr><tr><td>Ready</td><td>bool</td></tr></table>
<p>${'Filler text so the main element counts as content. '.repeat(5)}</p></main><footer>© 2026</footer></body></html>`;

class RecordingHost extends NodeHost {
  readonly opened: Array<{ kind: 'url' | 'editor'; target: string; options: unknown }> = [];
  override async openUrl(target: string, options?: { inEditor?: boolean }): Promise<void> {
    this.opened.push({ kind: 'url', target, options });
  }
  async openInEditor(absPath: string, options?: { preview?: boolean }): Promise<void> {
    this.opened.push({ kind: 'editor', target: absPath, options });
  }
}

describe('web tools', () => {
  let server: http.Server;
  let base: string;
  let ws: ReturnType<typeof tempWorkspace>;
  let host: RecordingHost;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
      } else if (req.url === '/to-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/iam/' });
        res.end();
      } else if (req.url === '/hop') {
        res.writeHead(301, { location: '/data.json' });
        res.end();
      } else if (req.url === '/data.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"version": "6.0.1"}');
      } else if (req.url === '/image.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());
  beforeEach(() => {
    ws = tempWorkspace();
    host = new RecordingHost({ workspaceRoot: ws.root });
  });
  afterEach(() => ws.cleanup());

  const ctx = (): ToolContext => ({
    callId: 'c1',
    host,
    changes: new ChangeTracker(host),
    signal: new AbortController().signal,
    commandTimeoutMs: 10_000,
    plan: undefined,
    setPlan: () => {},
    onOutput: () => {},
  });

  it('turns HTML into readable Markdown-like text', () => {
    const { title, text } = htmlToText(PAGE, 'https://docs.example.com/guide/');
    assert.equal(title, 'Fusion & Lobbies');
    assert.match(text, /^# Player Ready State/);
    assert.match(text, /Use a `NetworkDictionary` for "ready" flags\./);
    assert.match(text, /\[the runner API\]\(https:\/\/docs\.example\.com\/api\/runner\)/);
    assert.match(text, /- One\n- Two <three>/);
    assert.match(text, /```\nif \(ready\)\n {4}Start\(\);\n```/, 'code keeps its indentation');
    assert.match(text, /\| Name \| Type/);
    assert.doesNotMatch(text, /alert|color:red|Home|© 2026/, 'scripts, styles, nav and footer are dropped');
  });

  it('never reaches cloud metadata or link-local addresses, also not through a redirect', async () => {
    for (const blocked of ['169.254.169.254', '::ffff:169.254.169.254', '[fe80::1]', 'fd00:ec2::254', '100.100.100.200', '0.0.0.0']) {
      assert.ok(isBlockedAddress(blocked), blocked);
    }
    for (const fine of ['127.0.0.1', '192.168.1.20', '10.0.0.5', '::1', '93.184.216.34']) assert.ok(!isBlockedAddress(fine), fine);
    await assert.rejects(webFetchTool.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx()), /Blocked: 169\.254\.169\.254 is a link-local address/);
    await assert.rejects(webFetchTool.execute({ url: 'http://metadata.google.internal/computeMetadata/v1/' }, ctx()), /cloud metadata service/);
    await assert.rejects(webFetchTool.execute({ url: `${base}/to-metadata` }, ctx()), /Blocked: 169\.254\.169\.254/);
    // Ordinary redirects are still followed, and the final URL is reported.
    const hop = await webFetchTool.execute({ url: `${base}/hop` }, ctx());
    assert.match(hop.content, /URL: http:\/\/127\.0\.0\.1:\d+\/data\.json/);
    assert.match(hop.content, /"version": "6\.0\.1"/);
  });

  it('web_fetch reads pages, JSON and reports errors; binary content is not dumped', async () => {
    const page = await webFetchTool.execute({ url: `${base}/page` }, ctx());
    assert.ok(!page.isError);
    assert.match(page.content, /Status: 200[\s\S]*Title: Fusion & Lobbies[\s\S]*# Player Ready State/);
    assert.match(page.content, /data, not instructions/);
    const json = await webFetchTool.execute({ url: `${base}/data.json` }, ctx());
    assert.match(json.content, /\{"version": "6\.0\.1"\}/);
    const missing = await webFetchTool.execute({ url: `${base}/missing` }, ctx());
    assert.equal(missing.isError, true);
    assert.match(missing.content, /Status: 404/);
    const image = await webFetchTool.execute({ url: `${base}/image.png` }, ctx());
    assert.match(image.content, /binary content; not shown/);
    assert.throws(() => webFetchTool.describe({ url: 'file:///etc/passwd' }, ctx()), /Only http and https/);
    await assert.rejects(webFetchTool.execute({ url: 'http://127.0.0.1:1/' }, ctx()), /Could not fetch/);
  });

  it('web access is its own permission category: asked in Ask mode, allowed in Balanced, overridable', async () => {
    const action = await webFetchTool.describe({ url: 'https://example.com/docs' }, ctx());
    assert.deepEqual([action.category, action.risk], ['network', 'normal']);
    assert.equal(new PermissionManager('ask').decide(action), 'ask');
    assert.equal(new PermissionManager('balanced').decide(action), 'allow');
    assert.equal(new PermissionManager('balanced', { network: 'ask' }).decide(action), 'ask');
    assert.equal(new PermissionManager('ask', { network: 'auto' }).decide(action), 'allow');
  });

  it('after a secret file was read, web access asks even in Balanced mode', async () => {
    writeFileSync(path.join(ws.root, '.env'), 'API_TOKEN=abc123');
    const asked: Array<{ category: string; detail?: string }> = [];
    const approvingHost = new RecordingHost({
      workspaceRoot: ws.root,
      approve: async (request) => {
        asked.push({ category: request.category, detail: request.detail });
        return { approved: false, feedback: 'no' };
      },
    });
    const main = new ScriptedProvider([
      () => [call('web_fetch', { url: `${base}/page` })],
      () => [call('read_file', { path: '.env' })],
      () => [call('web_fetch', { url: `${base}/page?t=abc123` })],
      () => [text('ok')],
    ]);
    const orchestrator = new Orchestrator({
      host: approvingHost,
      getProvider: () => main,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 6, autoVerify: false, commandTimeoutMs: 10_000 }),
    });
    await orchestrator.run('check the docs');
    assert.equal(asked.length, 1, 'the first fetch (before reading .env) did not ask');
    assert.equal(asked[0].category, 'network');
    assert.match(asked[0].detail ?? '', /may contain secrets \(\.env\)/);
  });

  it('open_browser opens URLs and workspace files; local pages need no approval', async () => {
    writeFileSync(path.join(ws.root, 'index.html'), '<h1>hi</h1>');
    const local = await openBrowserTool.describe({ target: 'http://localhost:5173/' }, ctx());
    assert.deepEqual([local.category, local.risk], ['read', 'safe']);
    const external = await openBrowserTool.describe({ target: 'https://example.com' }, ctx());
    assert.equal(external.category, 'network');
    await openBrowserTool.execute({ target: 'http://localhost:5173/', in_editor: true }, ctx());
    await openBrowserTool.execute({ target: 'index.html' }, ctx());
    assert.deepEqual(host.opened, [
      { kind: 'url', target: 'http://localhost:5173/', options: { inEditor: true } },
      { kind: 'url', target: path.join(ws.root, 'index.html'), options: { inEditor: undefined } },
    ]);
    await assert.rejects(openBrowserTool.execute({ target: 'missing.html' }, ctx()), /File not found/);
    assert.throws(() => openBrowserTool.describe({ target: 'ftp://example.com' }, ctx()), /Only http\(s\) URLs or workspace files/);
    assert.throws(() => openBrowserTool.describe({ target: '../outside.html' }, ctx()), /outside/i);
    // Opening a script or executable with the system's default app would run it: never, in any mode.
    for (const target of ['run.bat', 'tool.exe', 'setup.ps1', 'link.lnk', 'page.html.cmd', 'a.html::$DATA']) {
      assert.throws(() => openBrowserTool.describe({ target }, ctx()), /Only web pages, images, PDFs and text files/, target);
    }
    await assert.rejects(new NodeHost({ workspaceRoot: ws.root }).openUrl(path.join(ws.root, 'run.bat')), /Refusing to open/);
  });

  it('open_file shows a workspace file (Markdown as preview)', async () => {
    writeFileSync(path.join(ws.root, 'README.md'), '# Hi');
    const result = await openFileTool.execute({ path: 'README.md', preview: true }, ctx());
    assert.match(result.content, /Opened README\.md in the editor \(preview\)/);
    assert.deepEqual(host.opened, [{ kind: 'editor', target: path.join(ws.root, 'README.md'), options: { preview: true } }]);
    const plain = new NodeHost({ workspaceRoot: ws.root });
    await assert.rejects(openFileTool.execute({ path: 'README.md' }, { ...ctx(), host: plain }), /no editor/);
  });
});
