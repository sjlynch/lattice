import fs from 'node:fs/promises';
import path from 'node:path';
import { qaSessionsRoot } from '../qaRuns/paths.js';
import { cleanupQaSession } from '../qaRuns.js';
import { forEachKnownProjectSafely } from './projectIteration.js';
import { collectLiveSessionCwds, hasLiveSessionAtOrUnder } from './liveSessions.js';

// At boot the in-memory qa-runs registry is empty (it isn't persisted — see
// qaRuns/registry.ts), so any directory under each project's qa scratch root
// is, by definition, leftover from a prior session whose /done callback never
// converged on cleanup (Windows EBUSY, a crash, or cleanup just being
// best-effort). cleanupQaSession kills any surviving PTYs, retries fs.rm with
// backoff, and is safe to run against an unknown id (its safety guards refuse
// anything outside the scratch root). Mirrors sweepOrphanedPushSessions.
export async function sweepOrphanedQaSessions(): Promise<void> {
  // A QA run still executing when the backend restarted looks orphaned to this
  // sweep (the in-memory registry is wiped on restart), but its PTY is still
  // live in the restart-surviving terminal-server. Snapshot the live session
  // cwds once so we can skip those dirs instead of killing the terminal.
  const liveCwds = await collectLiveSessionCwds();
  if (liveCwds === null) {
    console.warn(
      '[startup] qa sweep: terminal-server unreachable — skipping this pass ' +
        '(orphans get reclaimed on the next boot).',
    );
    return;
  }

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
      // A live PTY whose cwd sits at/under this dir means the session is still
      // running (its registry entry was just lost in the restart) — leave it
      // alone so we don't kill an active QA terminal.
      if (hasLiveSessionAtOrUnder(liveCwds, dir)) {
        console.log(`[startup] qa sweep: skipping ${id} — live PTY still attached`);
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
