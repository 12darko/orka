import { AppController } from '@orka/app';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { DesktopShell } from './DesktopShell';
import { openAppWindow, openExternal } from './native';
import { UiServer } from './server';

declare const ORKA_VERSION: string;
const VERSION = typeof ORKA_VERSION === 'string' ? ORKA_VERSION : '0.0.0-dev';

/** Quit this long after the window closed (a reload reconnects well within it). */
const IDLE_EXIT_MS = 20_000;
/** Give up when no window connects at all. */
const START_TIMEOUT_MS = 90_000;

const HELP = `Orka Desktop ${VERSION}

Usage
  orka-desktop [folder]      Open Orka in its own window, working in [folder]
                             (default: the folder used last)
Options
  --no-window                Start without opening a window; print the address instead
  --port <n>                 Listen on this port (default: any free port)
  -h, --help, -v, --version

Settings live in ~/.orka/desktop/settings.json (same keys as the VS Code extension);
API keys are kept in the operating system's protected storage.`;

interface Args {
  folder?: string;
  window: boolean;
  port: number;
}

function parseArgs(argv: readonly string[]): Args | { exit: number; text: string } {
  const args: Args = { window: true, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { exit: 0, text: HELP };
    if (a === '-v' || a === '--version') return { exit: 0, text: `orka-desktop ${VERSION}` };
    if (a === '--no-window') args.window = false;
    else if (a === '--port') {
      const port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) return { exit: 2, text: '--port needs a number (0-65535).' };
      args.port = port;
    } else if (a.startsWith('-')) return { exit: 2, text: `Unknown option: ${a}\n\n${HELP}` };
    else args.folder = path.resolve(a);
  }
  return args;
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('exit' in parsed) {
    (parsed.exit ? process.stderr : process.stdout).write(`${parsed.text}\n`);
    return parsed.exit;
  }
  const args = parsed;
  const home = process.env.ORKA_HOME || path.join(homedir(), '.orka');
  const uiStateFile = path.join(home, 'desktop', 'ui-state.json');
  let uiState: unknown = readJson(uiStateFile);

  let shell: DesktopShell | undefined;
  let controller: AppController | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await controller?.dispose().catch(() => undefined);
    shell?.dispose();
    server.close();
    process.exit(code);
  };

  const server = new UiServer({
    distDir: __dirname,
    onMessage: (message) => shell?.receive(message),
    getState: () => uiState,
    setState: (state) => {
      uiState = state;
      try {
        mkdirSync(path.dirname(uiStateFile), { recursive: true });
        writeFileSync(uiStateFile, JSON.stringify(state));
      } catch {
        /* only the unsent draft is lost */
      }
    },
    onConnect: () => {
      clearTimeout(idleTimer);
      shell?.resendDialogs();
    },
    onDisconnect: () => {
      // The window was closed: quit, unless it comes back (a reload).
      if (args.window) idleTimer = setTimeout(() => void shutdown(0), IDLE_EXIT_MS);
    },
  });

  shell = new DesktopShell(home, server, { folder: args.folder, skillsDir: path.join(__dirname, 'skills') });
  controller = new AppController(shell);
  await server.listen(args.port);
  await controller.initialize();
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  if (!args.window) {
    process.stdout.write(`ORKA_DESKTOP_URL=${server.startUrl}\n`);
    return new Promise<number>(() => undefined); // runs until stopped
  }
  process.stdout.write(`Orka Desktop ${VERSION}: close the Orka window to quit.\n`);
  const window = openAppWindow(server.startUrl, path.join(home, 'desktop', 'window'), shell.settings.get<string>('browser.path', '') || undefined);
  if (!window) {
    // No Chrome/Edge/Chromium: the default browser will do.
    process.stdout.write('No Edge or Chrome found; opening Orka in your default browser.\n');
    await openExternal(server.startUrl);
  }
  setTimeout(() => {
    if (!server.connected) void shutdown(1);
  }, START_TIMEOUT_MS).unref();
  return new Promise<number>(() => undefined);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`orka-desktop: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
