// A mkdir-based mutex serializing read-mutate-write of `~/.claude.json`.
//
// Claude itself rewrites this file on shutdown (lastCost, lastSessionId, …) and
// concurrent Lattice agents read-mutate-write it too, so overlapping writes
// would lost-update each other. `mkdir` is atomic on every platform — the first
// caller to create `LOCK_DIR` wins; the rest spin on a bounded backoff.
//
// The mutex only orders writes that overlap *in time*. It cannot stop the
// slower lost-update: Claude reads `~/.claude.json` once at startup, holds it in
// memory for the whole session, and writes the entire object back on shutdown,
// so a trust entry added between that read and that write is silently reverted.
// That race is shrunk elsewhere (a spawn-time re-apply microseconds before
// `pty.spawn`), not here — see ../claudeTrust.ts and apply.ts.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { sleep, rmdirQuietly } from './util.js';

const LOCK_DIR = path.join(os.homedir(), '.claude.json.lattice-lock');
// Bounded backoff between failed lock acquisitions. The leading `0` (try
// immediately, no wait) is prepended by the loop below; these are the
// post-collision waits.
const LOCK_RETRY_DELAYS_MS = [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];
// After the normal backoff is exhausted we assume the holder crashed and steal
// the dir once (see below), then compete for the freed slot via mkdir on this
// shorter backoff. A live caller that won the race releases its fast fn() well
// within this window; if it doesn't, we give up rather than run concurrently.
const STEAL_RETRY_DELAYS_MS = [10, 25, 50, 75, 100, 150, 200, 300];

// Attempt to create the lock dir. Returns true iff THIS call created it (and so
// exclusively owns it). EEXIST → another caller already holds it → false. Any
// other error is a real filesystem fault and propagates.
async function tryCreateLock(lockDir: string): Promise<boolean> {
  try {
    await fs.mkdir(lockDir);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return false;
  }
}

// Run `fn` while holding `lockDir`, then remove the dir afterwards. Only ever
// invoked immediately after a successful `tryCreateLock`, so the `finally`
// rmdir only ever removes a dir THIS call created — never a lock some other
// caller created.
async function runHoldingLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await rmdirQuietly(lockDir);
  }
}

// Test/advanced seam: lets a test point the mutex at a throwaway dir and shrink
// the backoff windows so the steal path can be exercised quickly. Production
// callers pass nothing and get the real `~/.claude.json` lock + delays.
export interface ConfigLockOptions {
  lockDir?: string;
  retryDelays?: readonly number[];
  stealRetryDelays?: readonly number[];
}

export async function withClaudeConfigLock<T>(
  fn: () => Promise<T>,
  opts: ConfigLockOptions = {},
): Promise<T> {
  const lockDir = opts.lockDir ?? LOCK_DIR;
  const retryDelays = opts.retryDelays ?? LOCK_RETRY_DELAYS_MS;
  const stealRetryDelays = opts.stealRetryDelays ?? STEAL_RETRY_DELAYS_MS;

  // Normal acquisition: first creator wins; the rest spin on the bounded
  // backoff. We only run `fn` when OUR mkdir created the dir.
  for (const delay of [0, ...retryDelays]) {
    if (delay) await sleep(delay);
    if (await tryCreateLock(lockDir)) return runHoldingLock(lockDir, fn);
  }

  // Backoff exhausted. A healthy fn() releases the lock in well under the time
  // we've already waited, so the holder is almost certainly a crashed writer
  // whose dir will never be removed. Steal it: remove the presumed-abandoned
  // dir ONCE, then compete for it via mkdir like any other caller.
  //
  // Crucially we do NOT keep deleting the dir, and we never run `fn` on a lost
  // mkdir. If a live caller grabs the freed slot first, our mkdir fails EEXIST
  // and we back off to let it finish — we must not nuke a lock it legitimately
  // holds nor read-modify-write `~/.claude.json` concurrently with it. That
  // overlap was the lost-update bug: the old steal swallowed the EEXIST, ran
  // fn() against the active holder anyway, and then deleted the holder's dir in
  // its `finally`, collapsing the mutex under a heavy spawn burst.
  await rmdirQuietly(lockDir);
  for (const delay of [0, ...stealRetryDelays]) {
    if (delay) await sleep(delay);
    if (await tryCreateLock(lockDir)) return runHoldingLock(lockDir, fn);
  }

  // A live holder kept the lock through the entire steal window. Give up rather
  // than run fn() concurrently with it. All callers treat a throw as a
  // best-effort failure (log + continue): worst case is one trust prompt or an
  // uncollected temp — never a silently dropped, overlapping write.
  throw new Error(
    'withClaudeConfigLock: could not acquire the ~/.claude.json lock; ' +
      'another holder kept it through the steal window',
  );
}
