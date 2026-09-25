import { sweepOrphanedHomeScratchSessions } from '../homeScratch/sweep.js';
import { pushPaths } from '../pushRuns/paths.js';
import { cleanupPushSession } from '../pushRuns.js';

// Boot recovery (oneOffRunResume.ts) has already put back every persisted
// push run whose PTY survived the restart, so any directory under each
// project's push scratch root whose PTY is no longer live is stale. The shared home-scratch
// sweep handles known-project iteration + live-PTY preservation; the push
// cleanup wrapper supplies the id/root guard and bounded recursive delete.
export async function sweepOrphanedPushSessions(): Promise<void> {
  await sweepOrphanedHomeScratchSessions({
    label: 'sweepOrphanedPushSessions',
    noun: 'push',
    paths: pushPaths,
    cleanup: cleanupPushSession,
  });
}
