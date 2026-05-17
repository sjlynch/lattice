import fs from 'node:fs/promises';
import { assertSafePushSessionPath } from './paths.js';
import { assertNotReparsePoint } from '../worktree/cleanupSafety.js';
import { pruneReparsePointsUnder } from '../worktree/reparsePoints.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';

// `fs.rm` on Windows fails with EBUSY/EPERM/ENOTEMPTY when something
// still holds a handle on the directory — typically the PTY whose cwd is
// the push session dir. The Stop hook fires *while Claude is still
// shutting down*, so the shell hosting Claude is still alive (and its
// cwd is the session dir) when /done is called. Killing the PTY first
// releases the handle; the retries cover the few hundred ms Windows
// needs to actually let go.
const RM_RETRY_DELAYS_MS = [150, 400, 900, 1500];

export async function cleanupPushSession(projectPath: string, id: string): Promise<void> {
  try {
    const dir = assertSafePushSessionPath(projectPath, id);
    await assertNotReparsePoint(dir);

    // Kill any PTY whose cwd is inside this dir before we try to delete
    // it. On Windows a process with this dir as its cwd holds a directory
    // handle that fails any rmdir until the process exits. (Mirrors
    // worktree/cleanup.ts.) Best-effort: the terminal server may already
    // have reaped the session by the time we get here.
    await proxyKillSessionsByCwd(dir).catch(() => undefined);
    // Brief pause so the OS has time to release handles after PTY exit.
    await new Promise<void>((r) => setTimeout(r, 300));

    // Claude should only leave a tiny instruction directory here, but this is
    // still a recursive delete. Strip any symlinks/junctions first so cleanup
    // cannot walk out of Lattice's home-scoped push scratch root.
    await pruneReparsePointsUnder(dir);

    if (!(await rmWithRetries(dir))) {
      // Leave the directory for the boot-time sweep
      // (sweepOrphanedPushSessions) to retry. Inert: it's under
      // ~/.lattice/per-project/<hash>/push/, never inside the project.
      console.warn(
        `[pushRuns] cleanup left ${id} in place after retries — ` +
          `the boot-time sweep will reclaim it on next restart.`,
      );
    }
  } catch (err) {
    // Safety-guard failures or unexpected throws land here, before any
    // recursive fs.rm is attempted.
    console.warn(`[pushRuns] cleanup skipped/failed for ${id}:`, err);
  }
}

async function rmWithRetries(target: string): Promise<boolean> {
  for (let attempt = 0; attempt <= RM_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient =
        code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (!transient || attempt === RM_RETRY_DELAYS_MS.length) {
        console.warn(
          `[pushRuns] fs.rm ${target} failed (${code ?? 'unknown'}):`,
          err,
        );
        return false;
      }
      await new Promise<void>((r) => setTimeout(r, RM_RETRY_DELAYS_MS[attempt]));
    }
  }
  return false;
}
