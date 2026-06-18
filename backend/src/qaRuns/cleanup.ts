import { assertSafeQaSessionPath } from './paths.js';
import { assertNotReparsePoint } from '../worktree/cleanupSafety.js';
import { pruneReparsePointsUnder } from '../worktree/reparsePoints.js';
import { fsRmWithRetries } from '../worktree/rmRetry.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';
import { notifySessionsFreed } from '../spawnQueue.js';

// Mirrors pushRuns/cleanup.ts. `fs.rm` on Windows fails with
// EBUSY/EPERM/ENOTEMPTY while the PTY whose cwd is the session dir is still
// shutting down (the Stop hook fires *before* Claude's shell exits). Killing
// the PTY first releases the directory handle; the retries cover the few
// hundred ms Windows needs to actually let go.
const RM_RETRY_DELAYS_MS = [150, 400, 900, 1500];

export async function cleanupQaSession(projectPath: string, id: string): Promise<void> {
  try {
    const dir = assertSafeQaSessionPath(projectPath, id);
    await assertNotReparsePoint(dir);

    // Kill any PTY whose cwd is inside this dir before deleting it — on
    // Windows a process with this dir as its cwd holds a handle that fails
    // any rmdir until it exits. Best-effort; the terminal server may have
    // reaped it already.
    await proxyKillSessionsByCwd(dir).catch(() => undefined);
    // Killing the QA session's pty freed a slot — poke the spawn queue.
    notifySessionsFreed();
    // Brief pause so the OS releases handles after PTY exit.
    await new Promise<void>((r) => setTimeout(r, 300));

    // Strip any symlinks/junctions first so cleanup cannot walk out of
    // Lattice's home-scoped qa scratch root before the recursive delete.
    await pruneReparsePointsUnder(dir);

    if (!(await fsRmWithRetries(dir, { delays: RM_RETRY_DELAYS_MS, logPrefix: '[qaRuns]' }))) {
      // Leave the directory for the boot-time sweep (sweepOrphanedQaSessions)
      // to retry. Inert: it's under ~/.lattice/per-project/<hash>/qa/, never
      // inside the project.
      console.warn(
        `[qaRuns] cleanup left ${id} in place after retries — ` +
          `the boot-time sweep will reclaim it on next restart.`,
      );
    }
  } catch (err) {
    // Safety-guard failures or unexpected throws land here, before any
    // recursive fs.rm is attempted.
    console.warn(`[qaRuns] cleanup skipped/failed for ${id}:`, err);
  }
}
