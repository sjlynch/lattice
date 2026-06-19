import fs from 'node:fs/promises';
import path from 'node:path';
import { pushSessionsRoot } from '../pushRuns/paths.js';
import { cleanupPushSession } from '../pushRuns.js';
import { forEachKnownProjectSafely } from './projectIteration.js';
import { collectLiveSessionCwds, hasLiveSessionAtOrUnder } from './liveSessions.js';

// At boot the in-memory push-runs registry is empty (it isn't persisted —
// see pushRuns/registry.ts), so any directory under each project's push
// scratch root is, by definition, leftover from a prior session whose
// /done callback never converged on cleanup (Windows EBUSY, a crash, or
// the cleanup just being best-effort). cleanupPushSession kills any
// surviving PTYs, retries fs.rm with backoff, and is safe to run against
// an unknown id (its safety guards refuse anything outside the scratch
// root). This is the convergence layer for the same reason
// sweepOrphanedWorktrees exists for worktrees.
export async function sweepOrphanedPushSessions(): Promise<void> {
  // Same hazard as the QA sweep: a push session still running when the backend
  // restarted looks orphaned here (registry wiped on restart) but its PTY is
  // still live in the restart-surviving terminal-server. Snapshot live cwds
  // once so we skip those dirs instead of killing the terminal.
  const liveCwds = await collectLiveSessionCwds();
  if (liveCwds === null) {
    console.warn(
      '[startup] push sweep: terminal-server unreachable — skipping this pass ' +
        '(orphans get reclaimed on the next boot).',
    );
    return;
  }

  await forEachKnownProjectSafely(
    'sweepOrphanedPushSessions',
    async (repoRoot) => {
      const root = pushSessionsRoot(repoRoot);
      let entries: string[];
      try {
        entries = await fs.readdir(root);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return;
        console.warn(
          `[startup] push sweep: cannot read ${root} (${code ?? 'unknown'}) — skipping.`,
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
        // A live PTY whose cwd sits at/under this dir means the session is
        // still running (its registry entry was just lost in the restart) —
        // leave it alone so we don't kill an active push terminal.
        if (hasLiveSessionAtOrUnder(liveCwds, dir)) {
          console.log(`[startup] push sweep: skipping ${id} — live PTY still attached`);
          continue;
        }
        // cleanupPushSession enforces the strict id regex; anything that
        // doesn't match its session-id shape gets refused and logged
        // without a delete (intentional — we won't touch unknown junk).
        const before = await dirExists(dir);
        await cleanupPushSession(repoRoot, id);
        const after = await dirExists(dir);
        if (before && !after) removed += 1;
      }

      if (removed > 0) {
        console.log(
          `[startup] push sweep: reclaimed ${removed} orphaned push session(s) in ${repoRoot}`,
        );
      }
    },
  );
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await fs.stat(dir);
    return true;
  } catch {
    return false;
  }
}
