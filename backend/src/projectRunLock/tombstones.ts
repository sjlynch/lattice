import fs from 'node:fs/promises';
import path from 'node:path';

// Retirement tombstones (`run.lock.retired/<sha256(raw body)>`, written by
// `retireLockFile`) are what make lock retirement a one-observer operation,
// so they must outlive any process that could still hold an observation of
// that generation. They do NOT have to outlive it forever: a generation's raw
// body carries a UUID `ownerId` and a timestamp, so it can never be re-issued,
// and a week after retirement no live process can be holding a pre-retirement
// read of it. Without pruning every retirement left a permanent file, and a
// busy project accumulated thousands.
//
// Pruning is done lazily, once per project per process, on the first
// acquisition — and ONLY while no `run.lock` exists (nothing is mid-retirement
// then). A tombstone whose age can't be read is kept.
export const RETIRED_TOMBSTONE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const TOMBSTONE_NAME_RE = /^[0-9a-f]{64}$/;

export async function pruneRetiredTombstones(
  lockFile: string,
  opts: { now?: number; maxAgeMs?: number } = {},
): Promise<number> {
  try {
    await fs.lstat(lockFile);
    return 0; // a lock exists — a retirement may be in flight; leave everything
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 0;
  }
  const dir = `${lockFile}.retired`;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? RETIRED_TOMBSTONE_MAX_AGE_MS);
  let pruned = 0;
  for (const name of names) {
    if (!TOMBSTONE_NAME_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) continue;
      // The body records when the retirement was claimed; fall back to the
      // file's mtime for one written before that field existed.
      let at = stat.mtimeMs;
      try {
        const body = JSON.parse(await fs.readFile(file, 'utf8')) as { at?: unknown };
        if (typeof body.at === 'number' && Number.isFinite(body.at)) at = body.at;
      } catch {
        /* unreadable body — age by mtime */
      }
      if (at >= cutoff) continue;
      await fs.unlink(file);
      pruned += 1;
    } catch {
      /* best effort — a tombstone we cannot judge is kept */
    }
  }
  return pruned;
}

const prunedThisProcess = new Set<string>();

export async function pruneRetiredTombstonesOnce(lockFile: string): Promise<void> {
  if (prunedThisProcess.has(lockFile)) return;
  prunedThisProcess.add(lockFile);
  try {
    const pruned = await pruneRetiredTombstones(lockFile);
    if (pruned > 0) {
      console.log(`[projectRunLock] pruned ${pruned} retirement tombstone(s) older than 7 days under ${lockFile}.retired`);
    }
  } catch {
    /* never let housekeeping block an acquisition */
  }
}
