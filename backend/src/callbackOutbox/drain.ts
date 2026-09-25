import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { callbackOutboxDir } from './paths.js';

// Backend side of the completion-callback outbox (see script.ts for the hook
// side): replay every callback a hook couldn't deliver because the backend
// was down or still recovering.
//
// An entry is a small JSON file `{v, url, createdAt, holdUntil, attempts,
// body?, contentType?}`. Replay is a plain HTTP POST back to our own origin —
// the exact request the hook would have made — so it goes through the same
// route, validation and idempotency guard as a live callback, and nothing
// here needs to know which kind of callback it is.
//
// Is a late replay safe? The terminal WS is relayed THROUGH this backend, so
// nobody can type into an agent's pty while the backend is down: an agent
// whose Stop was lost is still sitting idle at the end of that turn when the
// replay lands. (A newer Stop for the same URL overwrites the entry, and a
// delivered one removes it.)

export type OutboxEntry = {
  v: 1;
  url: string;
  createdAt: number;
  // The hook that wrote the entry is still retrying until this instant —
  // don't race it.
  holdUntil?: number;
  attempts?: number;
  lastAttemptAt?: number;
  lastError?: string;
  body?: string;
  contentType?: string;
  writer?: string;
};

export type DrainResult = {
  delivered: number;
  dropped: number;
  kept: number;
};

// Past this an entry is abandoned: whatever it was completing has long since
// been resolved another way (the in-progress sweep, a user nudge, a cancel).
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REPLAY_TIMEOUT_MS = 120_000;
const MAX_BACKOFF_MS = 60_000;

type DrainOptions = {
  backendOrigin: string;
  dir?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
};

// Same rule as the hook script: a 4xx other than 408/429 is a definitive
// answer (unknown task, stale step), retrying can't change it.
export function isFinalStatus(status: number): boolean {
  return status < 500 && status !== 408 && status !== 429;
}

// Only our own API is ever replayed. The outbox is a plain directory under
// the user's home; treating its contents as "POST wherever this says" would
// turn any stray file into a request the backend makes on its own authority.
export function isReplayableUrl(url: string, backendOrigin: string): boolean {
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(url);
    origin = new URL(backendOrigin);
  } catch {
    return false;
  }
  return parsed.origin === origin.origin && parsed.pathname.startsWith('/api/');
}

export function replayBackoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.max(0, attempts - 1));
}

function parseEntry(raw: string): OutboxEntry | null {
  try {
    const e = JSON.parse(raw) as Partial<OutboxEntry>;
    if (typeof e.url !== 'string' || typeof e.createdAt !== 'number') return null;
    return e as OutboxEntry;
  } catch {
    return null;
  }
}

async function removeQuietly(file: string): Promise<void> {
  await fs.unlink(file).catch(() => {});
}

async function replayOne(
  file: string,
  entry: OutboxEntry,
  opts: Required<Pick<DrainOptions, 'backendOrigin'>> & { now: number; fetchImpl: typeof fetch },
): Promise<'delivered' | 'dropped' | 'kept'> {
  const { now } = opts;
  if (now - entry.createdAt > OUTBOX_MAX_AGE_MS) {
    console.warn(`[callback-outbox] dropping stale callback ${entry.url} (queued ${new Date(entry.createdAt).toISOString()})`);
    await removeQuietly(file);
    return 'dropped';
  }
  if (!isReplayableUrl(entry.url, opts.backendOrigin)) {
    // Never ours to send — but not ours to delete either: another Lattice
    // instance sharing this home on a different port (an isolated test
    // instance, a second checkout) drains its own entries. The age cap above
    // is what eventually clears a genuinely orphaned one.
    return 'kept';
  }
  if (entry.holdUntil && entry.holdUntil > now) return 'kept';
  const attempts = entry.attempts ?? 0;
  if (entry.lastAttemptAt && now - entry.lastAttemptAt < replayBackoffMs(attempts)) return 'kept';

  let status: number | null = null;
  let error: string | undefined;
  try {
    const init: RequestInit = { method: 'POST', signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS) };
    if (entry.body !== undefined) {
      init.body = entry.body;
      init.headers = { 'Content-Type': entry.contentType ?? 'application/json' };
    }
    const res = await opts.fetchImpl(entry.url, init);
    status = res.status;
    await res.arrayBuffer().catch(() => undefined);
  } catch (err) {
    error = (err as Error)?.message ?? String(err);
  }

  if (status !== null && isFinalStatus(status)) {
    console.log(`[callback-outbox] replayed ${entry.url} → ${status} (queued ${Math.round((now - entry.createdAt) / 1000)}s ago)`);
    await removeQuietly(file);
    return status < 300 ? 'delivered' : 'dropped';
  }

  // Keep it for the next pass. Re-read first: a hook may have rewritten the
  // entry (a newer Stop for the same URL) while we were posting, and that
  // newer entry must win over our bookkeeping.
  const current = parseEntry(await fs.readFile(file, 'utf8').catch(() => ''));
  if (!current || current.createdAt !== entry.createdAt) return 'kept';
  await atomicWriteFile(
    file,
    JSON.stringify(
      {
        ...entry,
        attempts: attempts + 1,
        lastAttemptAt: now,
        lastError: status !== null ? `HTTP ${status}` : error,
      },
      null,
      2,
    ),
  ).catch(() => {});
  return 'kept';
}

export async function drainCallbackOutbox(opts: DrainOptions): Promise<DrainResult> {
  const dir = opts.dir ?? callbackOutboxDir();
  const now = (opts.now ?? Date.now)();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const result: DrainResult = { delivered: 0, dropped: 0, kept: 0 };
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return result; // no outbox yet
  }
  for (const name of names) {
    const file = path.join(dir, name);
    if (!name.endsWith('.json')) {
      // A temp file a crashed writer left behind.
      if (name.endsWith('.tmp')) {
        const st = await fs.stat(file).catch(() => null);
        if (st && now - st.mtimeMs > 60 * 60 * 1000) await removeQuietly(file);
      }
      continue;
    }
    const entry = parseEntry(await fs.readFile(file, 'utf8').catch(() => ''));
    if (!entry) {
      // Unparseable: either being written this instant (atomic rename makes
      // that unlikely) or garbage. Leave young files, drop old ones.
      const st = await fs.stat(file).catch(() => null);
      if (st && now - st.mtimeMs > 60 * 60 * 1000) await removeQuietly(file);
      continue;
    }
    // Sequential on purpose: a replayed `/complete` can finalize a merge, and
    // those serialize on the project lock anyway.
    result[await replayOne(file, entry, { backendOrigin: opts.backendOrigin, now, fetchImpl })]++;
  }
  return result;
}

const DRAIN_INTERVAL_MS = 10_000;
let loopTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;

// Replay on a short cadence for as long as the backend is up: an entry can
// appear at any time (a hook whose budget ran out while a request 503'd
// during boot recovery, say), not only at startup.
export function startCallbackOutboxLoop(backendOrigin: string): void {
  if (loopTimer) return;
  const tick = () => {
    if (draining) return;
    draining = true;
    drainCallbackOutbox({ backendOrigin })
      .catch((err) => console.warn('[callback-outbox] drain failed:', err))
      .finally(() => {
        draining = false;
      });
  };
  loopTimer = setInterval(tick, DRAIN_INTERVAL_MS);
  loopTimer.unref?.();
  tick();
}
