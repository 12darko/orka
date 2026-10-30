import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { checkAppUpdate, isNewerVersion, releasePageUrl, t, VERSION } from '@orka/core';
import { ORKA_HOME, type OrkaConfig } from './config';

/**
 * Tells about a newer Orka release without ever making startup wait: at most once a day a
 * background check asks GitHub and saves the answer, and the notice shows from that saved answer
 * at the next start, under the banner (never in the middle of a prompt or a reply). Nothing is
 * downloaded or installed.
 */

const STATE_FILE = path.join(ORKA_HOME, 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateState {
  /** When the last check started (ms); the next one waits a day, whatever its outcome. */
  checkedAt: number;
  etag?: string;
  /** The latest stable release that check found, and its page. */
  latest?: string;
  url?: string;
}

/**
 * At startup: the line to show about a newer release (from the saved answer, no network), with a
 * background check started when the last one is a day old. Returns at once. Only a person at a
 * terminal is told (-p runs and redirected output never check); "updateCheck": false in the
 * config or ORKA_NO_UPDATE_CHECK=1 turns it off.
 */
export function startUpdateCheck(options: { config: OrkaConfig; stdoutIsTTY: boolean; print: boolean }): string | undefined {
  if (!options.stdoutIsTTY || options.print || options.config.updateCheck === false || process.env.ORKA_NO_UPDATE_CHECK) return undefined;
  const now = Date.now();
  const state = readState();
  const age = state ? now - state.checkedAt : Infinity;
  if (!(age >= 0 && age < CHECK_INTERVAL_MS)) void refresh(state, now).catch(() => undefined);
  return notice(state);
}

function notice(state: UpdateState | undefined): string | undefined {
  if (!state?.latest || !isNewerVersion(state.latest, VERSION)) return undefined;
  // Only a link Orka itself builds for that version is shown.
  if (!state.url || ![releasePageUrl(`v${state.latest}`), releasePageUrl(state.latest)].includes(state.url)) return undefined;
  return t('Orka {version} is available: {url}', { version: state.latest, url: state.url });
}

/**
 * Ask GitHub and save the answer for the next start. Today's check is saved as done first, so
 * there is at most one a day even when it fails or Orka exits meanwhile (and none when the state
 * cannot be saved at all).
 */
async function refresh(previous: UpdateState | undefined, now: number): Promise<void> {
  await saveState({ ...previous, checkedAt: now });
  const result = await checkAppUpdate({ currentVersion: VERSION, etag: previous?.etag });
  // not_modified: the saved answer still holds; error: keep it and try again tomorrow.
  if (result.status !== 'newer' && result.status !== 'current') return;
  await saveState({ checkedAt: now, etag: result.etag, latest: result.latest, url: result.url });
}

function readState(): UpdateState | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    if (typeof r.checkedAt !== 'number' || !Number.isFinite(r.checkedAt)) return undefined;
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
    return { checkedAt: r.checkedAt, etag: text(r.etag), latest: text(r.latest), url: text(r.url) };
  } catch {
    return undefined;
  }
}

async function saveState(state: UpdateState): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state)}\n`);
}
