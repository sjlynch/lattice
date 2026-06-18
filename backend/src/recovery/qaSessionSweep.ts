import fs from 'node:fs/promises';
import path from 'node:path';
import { qaSessionsRoot } from '../qaRuns/paths.js';
import { cleanupQaSession } from '../qaRuns.js';
import { forEachKnownProjectSafely } from './projectIteration.js';

// At boot the in-memory qa-runs registry is empty (it isn't persisted — see
// qaRuns/registry.ts), so any directory under each project's qa scratch root
// is, by definition, leftover from a prior session whose /done callback never
// converged on cleanup (Windows EBUSY, a crash, or cleanup just being
// best-effort). cleanupQaSession kills any surviving PTYs, retries fs.rm with
// backoff, and is safe to run against an unknown id (its safety guards refuse
// anything outside the scratch root). Mirrors sweepOrphanedPushSessions.
export async function sweepOrphanedQaSessions(): Promise<void> {
  await forEachKnownProjectSafely('sweepOrphanedQaSessions', async (repoRoot) => {
    const root = qaSessionsRoot(repoRoot);
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      console.warn(
        `[startup] qa sweep: cannot read ${root} (${code ?? 'unknown'}) — skipping.`,
      );
      return;
    }

    let removed = 0;
    for (const id of entries) {
      const dir = path.join(root, id);
      try {
        const st = await fs.stat(dir);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      // cleanupQaSession enforces the strict id regex; anything that doesn't
      // match its session-id shape gets refused and logged without a delete.
      const before = await dirExists(dir);
      await cleanupQaSession(repoRoot, id);
      const after = await dirExists(dir);
      if (before && !after) removed += 1;
    }

    if (removed > 0) {
      console.log(
        `[startup] qa sweep: reclaimed ${removed} orphaned qa session(s) in ${repoRoot}`,
      );
    }
  });
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await fs.stat(dir);
    return true;
  } catch {
    return false;
  }
}
