import { sweepOrphanedHomeScratchSessions } from '../homeScratch/sweep.js';
import { pushPaths } from '../pushRuns/paths.js';
import { cleanupPushSession } from '../pushRuns.js';

// At boot the in-memory push-runs registry is empty (it isn't persisted —
// see pushRuns/registry.ts), so any directory under each project's push
// scratch root whose PTY is no longer live is stale. The shared home-scratch
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
