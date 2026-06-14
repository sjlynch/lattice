// The one shared transient-error recursive-delete retry loop. Previously
// duplicated as pushRuns/cleanup.ts's `rmWithRetries` and reconcile.ts's
// `tryRmWithRetries` — two near-identical Windows-specific helpers, a
// "why are there two of these?" hazard on the `.git`-deletion defence path.
//
// `fs.rm` on Windows fails with EBUSY/EPERM/ENOTEMPTY when something still
// holds a handle on the directory — typically a PTY whose cwd is the dir.
// The caller has usually killed those already; the retries give the OS the
// few hundred ms it needs to actually release the handle before we declare
// defeat. We treat ONLY that error set as transient; anything else fails
// immediately. On final failure we log and return false so the caller can
// leave the (inert, out-of-tree) dir for a boot-time sweep to reclaim.
//
// Behavior is byte-for-byte identical to the two originals — only what
// legitimately differed between them is parameterized: the per-attempt
// delays array (kept caller-supplied: the two sites intentionally use
// different values and must NOT be unified), the log prefix, and whether to
// run the reparse-point guards inside the loop. See the `.git`-deletion
// defences in backend/src/worktree/CLAUDE.md before touching this.

import fs from 'node:fs/promises';
import { assertNotReparsePoint } from './cleanupSafety.js';
import { pruneReparsePointsUnder } from './reparsePoints.js';

export interface FsRmWithRetriesOptions {
  // Per-attempt back-off (ms). The first attempt is immediate; on a transient
  // failure we sleep `delays[attempt]` before each retry, for `delays.length`
  // retries total. Caller-supplied on purpose — do NOT unify the values.
  delays: readonly number[];
  // Log tag for the final-failure warning (and, when `guardReparse` is set,
  // the prune-failure warning) so each caller keeps its own prefix.
  logPrefix: string;
  // When true, run the reparse-point guards before any fs.rm (reconcile's
  // stray-dir cleanup): refuse + bail if `target` itself is a symlink/junction
  // (`assertNotReparsePoint`), then strip any reparse points *inside* it
  // (`pruneReparsePointsUnder`, non-fatal) so the recursive delete can't walk
  // a junction loop. pushRuns/cleanup runs these guards in its own
  // orchestration before calling, so it leaves this off.
  guardReparse?: boolean;
}

export async function fsRmWithRetries(
  target: string,
  { delays, logPrefix, guardReparse = false }: FsRmWithRetriesOptions,
): Promise<boolean> {
  if (guardReparse) {
    // Reparse-point guard before any retry. If the path is a symlink or
    // Windows junction, fs.rm would recurse into the target and delete it —
    // catastrophic if the junction happened to point at the repo root or
    // its `.git`. Refuse loud and skip the rm entirely.
    try {
      await assertNotReparsePoint(target);
    } catch (err) {
      console.error((err as Error).message);
      return false;
    }
    // `assertNotReparsePoint` only checks `target` itself. A reparse point
    // *inside* it (e.g. an npm `file:` self-dep junction at
    // node_modules/<pkg> pointing back at target) would make the recursive
    // fs.rm below walk a loop. Strip those links first; failure is non-fatal.
    await pruneReparsePointsUnder(target).catch((err) =>
      console.warn(`${logPrefix} pruneReparsePointsUnder(${target}) failed (continuing):`, err),
    );
  }
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient =
        code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (!transient || attempt === delays.length) {
        console.warn(`${logPrefix} fs.rm ${target} failed (${code ?? 'unknown'}):`, err);
        return false;
      }
      await new Promise<void>((r) => setTimeout(r, delays[attempt]));
    }
  }
  return false;
}
