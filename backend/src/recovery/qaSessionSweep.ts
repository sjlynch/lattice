import { sweepOrphanedHomeScratchSessions } from '../homeScratch/sweep.js';
import { qaPaths } from '../qaRuns/paths.js';
import { cleanupQaSession } from '../qaRuns.js';

// At boot the in-memory QA registry is empty (it isn't persisted — see
// qaRuns/registry.ts), so any directory under each project's QA scratch root
// whose PTY is no longer live is stale. The shared home-scratch sweep handles
// known-project iteration + live-PTY preservation; the QA cleanup wrapper
// supplies the id/root guard and bounded recursive delete.
export async function sweepOrphanedQaSessions(): Promise<void> {
  await sweepOrphanedHomeScratchSessions({
    label: 'sweepOrphanedQaSessions',
    noun: 'qa',
    paths: qaPaths,
    cleanup: cleanupQaSession,
  });
}
