import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { closeBrowser, findBrowser } from '../src/browser/HeadlessBrowser';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { NodeHost } from '../src/host/NodeHost';
import { toClaudeMessages } from '../src/providers/ClaudeProvider';
import { toOpenAIMessages } from '../src/providers/OpenAIProvider';
import { browserTool } from '../src/tools/BrowserTools';
import type { ToolContext } from '../src/tools/Tool';
import type { ChatMessage } from '../src/types';
import { tempWorkspace } from './helpers';

const PAGE = `<!doctype html><title>Cart</title>
<h1 id="total">Total: 100</h1>
<input id="coupon" placeholder="coupon">
<button id="apply" onclick="document.getElementById('total').textContent = 'Total: ' + (document.getElementById('coupon').value === 'SAVE10' ? 90 : 100); console.error('coupon applied: ' + document.getElementById('coupon').value)">Apply</button>`;

describe('browser tool (real headless Chrome/Edge)', { skip: !findBrowser() && 'no Chrome/Edge/Chromium installed' }, () => {
  let server: http.Server;
  let base: string;
  const ws = tempWorkspace();
  const host = new NodeHost({ workspaceRoot: ws.root });
  const ctx: ToolContext = {
    callId: 'c',
    host,
    changes: new ChangeTracker(host),
    signal: new AbortController().signal,
    commandTimeoutMs: 30_000,
    plan: undefined,
    setPlan: () => {},
    onOutput: () => {},
  };

  before(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}/`;
  });
  after(() => {
    closeBrowser(host);
    server.close();
    ws.cleanup();
  });

  it('opens a local page, clicks, types, reads the result and the console', async () => {
    const opened = await browserTool.execute({ action: 'open', url: base }, ctx);
    assert.match(opened.content, /^Page: Cart - http:\/\/localhost:\d+\/\nScreenshot \(1280x800\) attached\./);
    assert.equal(opened.images?.[0].mediaType, 'image/jpeg');
    assert.ok((opened.images?.[0].data.length ?? 0) > 1000, 'a real screenshot');
    assert.match(opened.thumb ?? '', /^data:image\/jpeg;base64,/);

    await browserTool.execute({ action: 'click', selector: '#coupon' }, ctx);
    await browserTool.execute({ action: 'type', text: 'SAVE10' }, ctx);
    const clicked = await browserTool.execute({ action: 'click', selector: '#apply' }, ctx);
    assert.match(clicked.content, /Console errors:\n\[error\] coupon applied: SAVE10/, 'console errors come with the screenshot');

    const read = await browserTool.execute({ action: 'read' }, ctx);
    assert.match(read.content, /Title: Cart[\s\S]*Total: 90/);

    const action = await browserTool.describe({ action: 'click', x: 10, y: 10 }, ctx);
    assert.deepEqual([action.category, action.risk], ['read', 'safe'], 'using a local page needs no approval');
    const external = await browserTool.describe({ action: 'open', url: 'https://example.com' }, ctx);
    assert.equal(external.category, 'network');
  });

  it('screenshots reach the model inside tool results', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'browser', input: { action: 'screenshot' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'Page: Cart', images: [{ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }] }] },
    ];
    const claude = toClaudeMessages(messages)[1].content as unknown as Array<{ content: Array<{ type: string }> }>;
    assert.deepEqual(claude[0].content.map((b) => b.type), ['text', 'image']);
    const openai = toOpenAIMessages('S', messages) as unknown as Array<{ role: string; content: unknown }>;
    assert.equal(openai[2].role, 'tool');
    assert.equal(openai[3].role, 'user', 'the image follows the tool message');
  });
});
