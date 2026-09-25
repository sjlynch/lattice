import {
  sweepOrphanedHomeScratchSessions,
  type HomeScratchSweepDeps,
} from '../homeScratch/sweep.js';
import { postMergeHookPaths } from '../postMergeHooks/paths.js';
import { cleanupPostMergeHookSession } from '../postMergeHooks/cleanup.js';

// Post-merge hook scratch is home-scoped, like push/QA. On backend boot (after
// oneOffRunResume.ts re-adopted the hooks whose PTY survived), reclaim any
// pmh_* directory whose PTY did not survive in the detached terminal-server.
export async function sweepOrphanedPostMergeHookSessions(
  deps?: HomeScratchSweepDeps,
): Promise<void> {
  await sweepOrphanedHomeScratchSessions({
    label: 'sweepOrphanedPostMergeHookSessions',
    noun: 'post-merge hook',
    paths: postMergeHookPaths,
    cleanup: cleanupPostMergeHookSession,
    deps,
  });
}
