import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { killTree } from '../host/processes';

/**
 * A headless Chromium-family browser (Edge, Chrome or Chromium already installed on the machine)
 * driven over the Chrome DevTools Protocol, so the agent can look at pages: open, screenshot,
 * click, type, read text and console errors. No extra download, no dependency: the protocol is
 * JSON over a WebSocket.
 */
export interface Screenshot {
  /** JPEG, base64: for the model. */
  data: string;
  /** Small JPEG data URL: for the chat view. */
  thumb: string;
}

const WIDTH = 1280;
const HEIGHT = 800;
/** A cold start on a busy or slow machine (CI, antivirus scans) can take well over 20 seconds. */
const START_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 30_000;

export function findBrowser(explicit?: string): string | undefined {
  if (explicit?.trim()) return existsSync(explicit.trim()) ? explicit.trim() : undefined;
  const env = process.env;
  const candidates =
    process.platform === 'win32'
      ? [
          `${env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${env.ProgramFiles ?? 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${env.ProgramFiles ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
          `${env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
          `${env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
          `${env.LOCALAPPDATA ?? ''}\\Chromium\\Application\\chrome.exe`,
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  return candidates.find((c) => c && existsSync(c));
}

/** One browser per host (workspace), started on first use. */
const browsers = new WeakMap<object, HeadlessBrowser>();

export function browserFor(host: { browserPath?: string }): HeadlessBrowser {
  let browser = browsers.get(host);
  if (!browser) {
    browser = new HeadlessBrowser(host.browserPath);
    browsers.set(host, browser);
  }
  return browser;
}

export function closeBrowser(host: object): void {
  browsers.get(host)?.close();
  browsers.delete(host);
}

export class HeadlessBrowser {
  private proc?: ChildProcess;
  private socket?: WebSocket;
  private profileDir?: string;
  private sessionId?: string;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly events = new Set<(method: string, params: any) => void>();
  private starting?: Promise<void>;
  /** Console messages and page errors since the last read. */
  private consoleLog: string[] = [];
  url = 'about:blank';

  constructor(private readonly executable?: string) {}

  get running(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  private ensure(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.starting ??= this.launch().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async launch(): Promise<void> {
    const exe = findBrowser(this.executable);
    if (!exe) throw new Error('No Chrome, Edge or Chromium found on this machine. Install one, or set its path in the settings.');
    this.profileDir = mkdtempSync(path.join(tmpdir(), 'orka-browser-'));
    this.proc = spawn(
      exe,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        `--window-size=${WIDTH},${HEIGHT}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' },
    );
    // The browser writes its DevTools port and path to this file once it listens.
    const portFile = path.join(this.profileDir, 'DevToolsActivePort');
    const deadline = Date.now() + START_TIMEOUT_MS;
    let endpoint: string | undefined;
    while (Date.now() < deadline) {
      const text = await fs.readFile(portFile, 'utf8').catch(() => '');
      const [port, wsPath] = text.split(/\r?\n/);
      if (port && wsPath) {
        endpoint = `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
        break;
      }
      if (this.proc.exitCode !== null) throw new Error(`The browser exited right away (${exe}).`);
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!endpoint) throw new Error('The browser did not start in time.');
    this.socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      this.socket!.addEventListener('open', () => resolve(), { once: true });
      this.socket!.addEventListener('error', () => reject(new Error('Could not connect to the browser.')), { once: true });
    });
    this.socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    this.socket.addEventListener('close', () => this.failAll('The browser connection closed.'));
    const { targetInfos } = await this.send('Target.getTargets');
    let target = (targetInfos as Array<{ targetId: string; type: string }>).find((t) => t.type === 'page')?.targetId;
    target ??= (await this.send('Target.createTarget', { url: 'about:blank' })).targetId;
    this.sessionId = (await this.send('Target.attachToTarget', { targetId: target, flatten: true })).sessionId;
    await this.page('Page.enable');
    await this.page('Runtime.enable');
    await this.page('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    this.events.add((method, params) => {
      if (method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'log'].includes(params.type)) {
        const text = (params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ');
        this.consoleLog.push(`[${params.type}] ${text}`.slice(0, 500));
      } else if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails;
        this.consoleLog.push(`[exception] ${d?.exception?.description ?? d?.text ?? 'error'}`.slice(0, 800));
      } else if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
        this.url = params.frame?.url ?? this.url;
      }
      this.consoleLog = this.consoleLog.slice(-60);
    });
  }

  async navigate(url: string): Promise<void> {
    await this.ensure();
    const loaded = this.waitFor('Page.loadEventFired', 15_000);
    const result = await this.page('Page.navigate', { url });
    if (result.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`);
    await loaded.catch(() => undefined);
    this.url = url;
    await settle();
  }

  async screenshot(): Promise<Screenshot> {
    await this.ensure();
    const full = await this.page('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    const small = await this.page('Page.captureScreenshot', { format: 'jpeg', quality: 50, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 0.3 } });
    return { data: full.data, thumb: `data:image/jpeg;base64,${small.data}` };
  }

  async click(x: number, y: number): Promise<void> {
    await this.ensure();
    await this.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await settle();
  }

  /** Click the center of the first element matching a CSS selector (scrolled into view). */
  async clickSelector(selector: string): Promise<void> {
    const box = await this.evaluate(
      // The selector travels URI-encoded: that text cannot contain a quote or backslash to break out with.
      `(() => { const el = document.querySelector(decodeURIComponent("${encodeURIComponent(selector)}")); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (!box) throw new Error(`No element matches ${selector}`);
    await this.click(box.x, box.y);
  }

  async type(text: string): Promise<void> {
    await this.ensure();
    await this.page('Input.insertText', { text });
    await settle();
  }

  async press(key: string): Promise<void> {
    await this.ensure();
    const k = KEYS[key.toLowerCase()] ?? { key, code: key, keyCode: 0 };
    await this.page('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, text: k.text });
    await this.page('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
    await settle();
  }

  async scroll(deltaY: number): Promise<void> {
    await this.ensure();
    await this.page('Input.dispatchMouseEvent', { type: 'mouseWheel', x: WIDTH / 2, y: HEIGHT / 2, deltaX: 0, deltaY });
    await settle();
  }

  /** Title, URL and visible text of the page. */
  async text(): Promise<{ title: string; url: string; text: string }> {
    const r = await this.evaluate('({ title: document.title, url: location.href, text: document.body ? document.body.innerText : "" })');
    this.url = r?.url ?? this.url;
    return { title: r?.title ?? '', url: r?.url ?? this.url, text: String(r?.text ?? '') };
  }

  /** Console output and uncaught errors since the last call. */
  takeConsole(): string[] {
    const out = this.consoleLog;
    this.consoleLog = [];
    return out;
  }

  close(): void {
    this.failAll('The browser was closed.');
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = undefined;
    killTree(this.proc?.pid);
    this.proc = undefined;
    if (this.profileDir) {
      const dir = this.profileDir;
      this.profileDir = undefined;
      // The browser (and its crash reporter) may hold files for a while after it is killed; a
      // leftover temp folder is harmless, an exception thrown from a timer would crash the app.
      setTimeout(() => void fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => undefined), 1500).unref?.();
    }
  }

  /** Run a JavaScript expression in the page and return its (JSON) value. */
  async evaluate(expression: string): Promise<any> {
    await this.ensure();
    const result = await this.page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Script error');
    return result.result?.value;
  }

  private page(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.send(method, params, this.sessionId);
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('The browser is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer ${method} in time.`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  private waitFor(method: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.events.delete(listener);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      const listener = (m: string, params: any) => {
        if (m !== method) return;
        clearTimeout(timer);
        this.events.delete(listener);
        resolve(params);
      };
      this.events.add(listener);
    });
  }

  private onMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Browser error'));
      else pending.resolve(message.result ?? {});
    } else if (message.method) {
      for (const listener of [...this.events]) listener(message.method, message.params ?? {});
    }
  }

  private failAll(reason: string): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/** Let the page react (network, rendering) before the next screenshot. */
function settle(ms = 400): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};
