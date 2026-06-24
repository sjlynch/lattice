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

export async function withClaudeConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  for (const delay of [0, ...LOCK_RETRY_DELAYS_MS]) {
    if (delay) await sleep(delay);
    try {
      await fs.mkdir(LOCK_DIR);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      continue;
    }
    try {
      return await fn();
    } finally {
      await rmdirQuietly(LOCK_DIR);
    }
  }
  // Lock never acquired (likely stale from a crashed writer). Steal and
  // proceed — trust pre-seed is best-effort and a lost-update here just
  // means the dialog might appear once.
  await rmdirQuietly(LOCK_DIR);
  await fs.mkdir(LOCK_DIR).catch(() => {});
  try {
    return await fn();
  } finally {
    await rmdirQuietly(LOCK_DIR);
  }
}
