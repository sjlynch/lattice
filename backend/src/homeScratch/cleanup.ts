import { assertNotReparsePoint } from '../worktree/cleanupSafety.js';
import { pruneReparsePointsUnder } from '../worktree/reparsePoints.js';
import { fsRmWithRetries } from '../worktree/rmRetry.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';
import { notifySessionsFreed } from '../spawnQueue.js';
import type { HomeScratchPaths } from './paths.js';

// `fs.rm` on Windows fails with EBUSY/EPERM/ENOTEMPTY when something still
// holds a handle on the directory — typically the PTY whose cwd is the session
// dir. The Stop hook fires *while the agent is still shutting down*, so the
// shell hosting it is still alive (and its cwd is the session dir) when /done
// is called. Killing the PTY first releases the handle; the retries cover the
// few hundred ms Windows needs to actually let go.
const RM_RETRY_DELAYS_MS = [150, 400, 900, 1500];

// Bounded recursive scratch delete shared by push + QA cleanup. Gated through
// the feature's `assertSafeSessionPath` (id regex + strictly-under-root +
// not-inside-repo) and `assertNotReparsePoint`, so the recursive removal can
// never walk out of the home-scoped scratch root toward `.git`. On failure it
// leaves the dir for the boot-time sweep rather than forcing the delete.
export async function cleanupHomeScratchSession(args: {
  paths: HomeScratchPaths;
  projectPath: string;
  id: string;
  logLabel: string;
}): Promise<void> {
  const { paths, projectPath, id, logLabel } = args;
  try {
    const dir = paths.assertSafeSessionPath(projectPath, id);
    await assertNotReparsePoint(dir);

    // Kill any PTY whose cwd is inside this dir before we try to delete it. On
    // Windows a process with this dir as its cwd holds a directory handle that
    // fails any rmdir until the process exits. (Mirrors worktree/cleanup.ts.)
    // Best-effort: the terminal server may already have reaped the session by
    // the time we get here.
    await proxyKillSessionsByCwd(dir).catch(() => undefined);
    // Killing the session's pty freed a slot — poke the spawn queue.
    notifySessionsFreed();
    // Brief pause so the OS has time to release handles after PTY exit.
    await new Promise<void>((r) => setTimeout(r, 300));

    // Claude should only leave a tiny instruction directory here, but this is
    // still a recursive delete. Strip any symlinks/junctions first so cleanup
    // cannot walk out of Lattice's home-scoped scratch root.
    await pruneReparsePointsUnder(dir);

    if (
      !(await fsRmWithRetries(dir, {
        delays: RM_RETRY_DELAYS_MS,
        logPrefix: logLabel,
      }))
    ) {
      // Leave the directory for the boot-time sweep to retry. Inert: it's under
      // ~/.lattice/per-project/<hash>/<dir>/, never inside the project.
      console.warn(
        `${logLabel} cleanup left ${id} in place after retries — ` +
          `the boot-time sweep will reclaim it on next restart.`,
      );
    }
  } catch (err) {
    // Safety-guard failures or unexpected throws land here, before any
    // recursive fs.rm is attempted.
    console.warn(`${logLabel} cleanup skipped/failed for ${id}:`, err);
  }
}
