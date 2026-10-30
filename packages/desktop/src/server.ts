import type { FromWebview, ToWebview } from '@orka/app';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

const MAX_BODY = 25 * 1024 * 1024; // pasted images
/** How long the start URL works (the window opens well within this; the app quits after 90 s without one). */
const LAUNCH_CODE_TTL_MS = 3 * 60_000;
const STATIC: Record<string, string> = {
  '/webview.js': 'text/javascript; charset=utf-8',
  '/webview.css': 'text/css; charset=utf-8',
  '/ide.css': 'text/css; charset=utf-8',
  '/theme.css': 'text/css; charset=utf-8',
  '/icon.png': 'image/png',
};

/** How the page looks; chosen as it loads, so the first paint is already right. */
export interface PageLook {
  layout: 'ide' | 'classic';
  theme: 'system' | 'light' | 'dark';
}

export interface UiServerOptions {
  /** Where webview.js, webview.css, ide.css and theme.css are. */
  distDir: string;
  onMessage(message: FromWebview): void;
  /** The chat UI's saved state (draft text), handed to a page as it loads. */
  getState(): unknown;
  setState(state: unknown): void;
  /** The layout and theme settings (default: the IDE layout, following the system's theme). */
  getLook?(): PageLook;
  onConnect?(): void;
  onDisconnect?(): void;
}

/**
 * Serves the chat UI to Orka's window on 127.0.0.1 and carries the messages between it and the
 * controller: server-sent events to the page, POSTs from it. Only a browser that opened the
 * secret start URL gets in (a cookie), requests must name this server as their host (no DNS
 * rebinding), and state-changing requests must come from the page itself.
 */
export class UiServer {
  private readonly server: http.Server;
  private readonly clients = new Set<http.ServerResponse>();
  /** Messages posted while no page was connected (e.g. between a reload and its reconnect). */
  private backlog: ToWebview[] = [];
  private heartbeat?: NodeJS.Timeout;
  /**
   * One-time code in the start URL. The browser's command line shows it to other local processes,
   * so it works once, within a few minutes, and the session cookie is a different secret.
   */
  private launchCode?: string = randomBytes(24).toString('base64url');
  private launchCodeExpires = 0;
  /** The session cookie's value; never on a command line or in a URL. */
  private readonly session = randomBytes(24).toString('base64url');
  port = 0;

  constructor(private readonly options: UiServerOptions) {
    this.server = http.createServer((req, res) => {
      try {
        this.handle(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
  }

  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    this.launchCodeExpires = Date.now() + LAUNCH_CODE_TTL_MS;
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, 15_000);
    return this.port;
  }

  /** The address that lets a browser in, once (it sets the session cookie). */
  get startUrl(): string {
    return `http://127.0.0.1:${this.port}/?t=${this.launchCode ?? 'used'}`;
  }

  get connected(): boolean {
    return this.clients.size > 0;
  }

  post(message: ToWebview): void {
    if (!this.clients.size) {
      this.backlog.push(message);
      if (this.backlog.length > 500) this.backlog = this.backlog.slice(-500);
      return;
    }
    const data = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of this.clients) res.write(data);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.server.close();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      res.writeHead(421).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    const security = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

    // The start URL: trade the one-time code for the session cookie, then load the page without the code in it.
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
      if (!this.launchCode || url.searchParams.get('t') !== this.launchCode || Date.now() > this.launchCodeExpires) {
        res.writeHead(403, security).end('Forbidden');
        return;
      }
      this.launchCode = undefined;
      res.writeHead(303, { ...security, location: '/', 'set-cookie': `orka=${this.session}; HttpOnly; SameSite=Strict; Path=/` });
      res.end();
      return;
    }
    if (cookie(req.headers.cookie, 'orka') !== this.session) {
      res.writeHead(403, security).end('Forbidden: open Orka from its own window.');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        ...security,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          "style-src 'self'",
          // No remote images: model output could otherwise leak data through image URLs.
          "img-src 'self' data:",
          "font-src 'self'",
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      });
      res.end(page(nonce, this.options.getState(), this.options.getLook?.() ?? { layout: 'ide', theme: 'system' }));
      return;
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      let body: Buffer;
      try {
        body = readFileSync(path.join(this.options.distDir, url.pathname.slice(1)));
      } catch {
        res.writeHead(404, security).end();
        return;
      }
      res.writeHead(200, { ...security, 'content-type': STATIC[url.pathname] });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { ...security, 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.write(': connected\n\n');
      this.clients.add(res);
      const backlog = this.backlog;
      this.backlog = [];
      for (const message of backlog) res.write(`data: ${JSON.stringify(message)}\n\n`);
      req.on('close', () => {
        this.clients.delete(res);
        if (!this.clients.size) this.options.onDisconnect?.();
      });
      this.options.onConnect?.();
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/message' || url.pathname === '/state')) {
      const origin = req.headers.origin;
      if (origin !== `http://${host}` || !String(req.headers['content-type']).startsWith('application/json')) {
        res.writeHead(403, security).end();
        return;
      }
      readBody(req)
        .then((raw) => {
          const value: unknown = JSON.parse(raw);
          if (url.pathname === '/state') this.options.setState(value);
          else if (value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string') this.options.onMessage(value as FromWebview);
          res.writeHead(204, security).end();
        })
        .catch(() => res.writeHead(400, security).end());
      return;
    }
    res.writeHead(404, security).end();
  }
}

function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The window's page: the chat UI plus a small bridge standing in for VS Code's webview API
 * (acquireVsCodeApi): messages go out as POSTs once the event stream is open, and come in as
 * window messages, exactly as in VS Code.
 */
function page(nonce: string, state: unknown, look: PageLook): string {
  const initial = JSON.stringify(state ?? null).replace(/</g, '\\u003c');
  // Only known values reach the markup.
  const layout = look.layout === 'classic' ? 'classic' : 'ide';
  const theme = look.theme === 'light' || look.theme === 'dark' ? look.theme : 'system';
  return `<!DOCTYPE html>
<html lang="en" translate="no" data-layout="${layout}" data-theme="${theme}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/icon.png">
  <link rel="stylesheet" href="/webview.css">
  <link rel="stylesheet" href="/ide.css">
  <link rel="stylesheet" href="/theme.css">
  <title>Orka</title>
</head>
<body>
  <div id="app"></div>
  <script type="application/json" id="orka-state">${initial}</script>
  <script nonce="${nonce}">
    (() => {
      let state = JSON.parse(document.getElementById('orka-state').textContent);
      let saveTimer;
      let sending = Promise.resolve();
      const events = new EventSource('/events');
      const open = new Promise((resolve) => events.addEventListener('open', resolve, { once: true }));
      events.onmessage = (e) => window.postMessage(JSON.parse(e.data), location.origin);
      const send = (url, body) =>
        (sending = sending.then(() => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).catch(() => undefined));
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => open.then(() => send('/message', message)),
        getState: () => state,
        setState: (next) => {
          state = next;
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => send('/state', state), 400);
        },
      });
    })();
  </script>
  <script nonce="${nonce}" src="/webview.js"></script>
</body>
</html>`;
}
