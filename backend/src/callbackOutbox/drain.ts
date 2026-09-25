import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
// Is a late replay safe? Nobody can type into an agent's pty while the backend
// is down (the terminal WS is relayed THROUGH it) — but the replay lands after
// the backend is back, and by then the user may have started a new turn. So
// every replay carries the entry's `createdAt` in `OUTBOX_REPLAY_HEADER`, and
// a task `/complete` refuses one its session has since moved past
// (`replayGuard.ts`). (A newer Stop for the same URL overwrites the entry, and
// a delivered one removes it.)

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
// Set on every replay: when the callback was queued (the entry's `createdAt`,
// i.e. when the Stop fired). Marks the request as a replay for the ack
// middleware, and lets a route tell a stale callback from a current one.
export const OUTBOX_REPLAY_HEADER = 'x-lattice-outbox-created-at';
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

// The completion-callback routes — the only thing an outbox entry may target
// (also the ack middleware's filter).
export const CALLBACK_PATH_RE =
  /\/(?:complete|done|verdict|merged|merge-aborted|stash-resolved)$/;

// Only our own completion callbacks are ever replayed. The outbox is a plain
// directory under the user's home; treating its contents as "POST wherever
// this says" would turn any stray file into a request the backend makes on its
// own authority — `/api/merge-runs`, `/api/workflows/:id/run`, ….
//   'replay'  — ours, a callback route: send it.
//   'foreign' — another origin: not ours to send OR delete (see replayOne).
//   'refuse'  — our origin but not a callback route (or unparseable): never
//               sent, dropped.
export function classifyReplayUrl(url: string, backendOrigin: string): 'replay' | 'foreign' | 'refuse' {
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(url);
    origin = new URL(backendOrigin);
  } catch {
    return 'refuse';
  }
  if (parsed.origin !== origin.origin) return 'foreign';
  return parsed.pathname.startsWith('/api/') && CALLBACK_PATH_RE.test(parsed.pathname)
    ? 'replay'
    : 'refuse';
}

export function isReplayableUrl(url: string, backendOrigin: string): boolean {
  return classifyReplayUrl(url, backendOrigin) === 'replay';
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

async function readEntryFile(file: string): Promise<OutboxEntry | null> {
  return parseEntry(await fs.readFile(file, 'utf8').catch(() => ''));
}

// Is `file` still the entry we read (same `createdAt`)? A hook writes a newer
// entry for the same URL on every Stop, and the ack middleware / the hook
// itself remove a delivered one — neither may be undone by the drain.
async function stillSameEntry(file: string, entry: OutboxEntry): Promise<boolean> {
  const current = await readEntryFile(file);
  return current !== null && current.createdAt === entry.createdAt;
}

// Remove the entry only if it is still the one we replayed.
async function removeIfSame(file: string, entry: OutboxEntry): Promise<void> {
  if (await stillSameEntry(file, entry)) await removeQuietly(file);
}

// Rewrite the entry's bookkeeping without resurrecting or clobbering it: write
// the temp file first and re-check right before the rename, so the only window
// in which a concurrent unlink / newer write could be lost is the rename
// itself rather than a whole write.
async function rewriteIfSame(file: string, entry: OutboxEntry, next: OutboxEntry): Promise<void> {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(next, null, 2));
    if (!(await stillSameEntry(file, entry))) return;
    await fs.rename(tmp, file);
  } catch {
    // Best-effort bookkeeping — the next pass re-reads whatever is there.
  } finally {
    await removeQuietly(tmp);
  }
}

async function replayOne(
  file: string,
  entry: OutboxEntry,
  opts: Required<Pick<DrainOptions, 'backendOrigin'>> & { now: number; fetchImpl: typeof fetch },
): Promise<'delivered' | 'dropped' | 'kept'> {
  const { now } = opts;
  if (now - entry.createdAt > OUTBOX_MAX_AGE_MS) {
    console.warn(`[callback-outbox] dropping stale callback ${entry.url} (queued ${new Date(entry.createdAt).toISOString()})`);
    await removeIfSame(file, entry);
    return 'dropped';
  }
  const kind = classifyReplayUrl(entry.url, opts.backendOrigin);
  if (kind === 'foreign') {
    // Never ours to send — but not ours to delete either: another Lattice
    // instance sharing this home on a different port (an isolated test
    // instance, a second checkout) drains its own entries. The age cap above
    // is what eventually clears a genuinely orphaned one.
    return 'kept';
  }
  if (kind === 'refuse') {
    console.warn(`[callback-outbox] dropping ${entry.url}: not a completion callback route`);
    await removeIfSame(file, entry);
    return 'dropped';
  }
  if (entry.holdUntil && entry.holdUntil > now) return 'kept';
  const attempts = entry.attempts ?? 0;
  if (entry.lastAttemptAt && now - entry.lastAttemptAt < replayBackoffMs(attempts)) return 'kept';

  let status: number | null = null;
  let error: string | undefined;
  try {
    const headers: Record<string, string> = { [OUTBOX_REPLAY_HEADER]: String(entry.createdAt) };
    const init: RequestInit = { method: 'POST', headers, signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS) };
    if (entry.body !== undefined) {
      init.body = entry.body;
      headers['Content-Type'] = entry.contentType ?? 'application/json';
    }
    const res = await opts.fetchImpl(entry.url, init);
    status = res.status;
    await res.arrayBuffer().catch(() => undefined);
  } catch (err) {
    error = (err as Error)?.message ?? String(err);
  }

  if (status !== null && isFinalStatus(status)) {
    console.log(`[callback-outbox] replayed ${entry.url} → ${status} (queued ${Math.round((now - entry.createdAt) / 1000)}s ago)`);
    // A hook may have written a newer entry for the same URL (a newer Stop)
    // while we were posting — that one still has to be delivered.
    await removeIfSame(file, entry);
    return status < 300 ? 'delivered' : 'dropped';
  }

  // Keep it for the next pass — unless, while we were posting, the entry was
  // delivered and removed (it must stay gone) or replaced by a newer Stop
  // (which must win over our bookkeeping).
  await rewriteIfSame(file, entry, {
    ...entry,
    attempts: attempts + 1,
    lastAttemptAt: now,
    lastError: status !== null ? `HTTP ${status}` : error,
  });
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
