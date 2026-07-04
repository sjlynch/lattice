// Persistence I/O for the health cache: the raw read and the crash-safe
// atomic write. Split out of the cache class so the class holds only in-memory
// state transitions — all filesystem contact (temp write, Windows rename
// retry, temp cleanup, mkdir of the cache dir) lives here.

import fs from 'node:fs/promises';
import { cacheDir, cachePath } from './cachePaths.js';

// Monotonic suffix so two writers in the same process+millisecond still get
// distinct temp names (the cross-instance race this whole writer guards
// against would otherwise reuse one temp path). Deliberately a counter, not a
// timestamp, so it stays unique within a single millisecond.
let tmpSeq = 0;

// On Windows `fs.rename` over an existing target throws EPERM/EBUSY/EACCES
// when another handle has it briefly open; a short bounded retry lets the swap
// land once that handle closes (mirrors claudeTrust/configFile.ts).
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];

// Atomic write: serialize into a unique temp under the same dir, then rename
// over the target. rename is atomic on POSIX and ~atomic on Windows, so a
// reader (or a second concurrent writer) never observes a half-written file —
// the whole point, since the scanner's HealthCache and the watcher's both
// target one <root>/.lattice/health-cache.json. The temp shares the cache
// dir so the rename stays on one filesystem.
async function atomicWriteCache(target: string, content: string): Promise<void> {
  const tmp = `${target}.${process.pid}-${tmpSeq++}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    for (let i = 0; ; i++) {
      try {
        await fs.rename(tmp, target);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
        if (!transient || i >= RENAME_RETRY_DELAYS_MS.length) throw err;
        await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[i]));
      }
    }
  } catch (err) {
    // Best-effort: drop the temp so a failed write doesn't leak it. unlink (not
    // a recursive rm) on a single file inside the project is safe.
    await fs.unlink(tmp).catch(() => { /* ignore */ });
    throw err;
  }
}

// Read the raw cache JSON. Rejects when the file is missing or unreadable; the
// caller starts fresh in that case.
export function readCacheFile(projectRoot: string): Promise<string> {
  return fs.readFile(cachePath(projectRoot), 'utf8');
}

// Ensure the cache dir exists, then atomically replace the cache file with
// `content`.
export async function writeCacheFile(projectRoot: string, content: string): Promise<void> {
  await fs.mkdir(cacheDir(projectRoot), { recursive: true });
  await atomicWriteCache(cachePath(projectRoot), content);
}
