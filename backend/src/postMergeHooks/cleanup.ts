import { cleanupHomeScratchSession } from '../homeScratch/cleanup.js';
import { postMergeHookPaths } from './paths.js';

// Bounded recursive delete of a post-merge hook's home-scoped scratch dir.
// Mirrors push/QA cleanup: validate the pmh_* id and root, kill any PTY still
// rooted under the scratch dir, strip reparse points, then rm with retries. On
// failure the boot-time post-merge sweep retries later.
export function cleanupPostMergeHookSession(
  projectPath: string,
  id: string,
): Promise<void> {
  return cleanupHomeScratchSession({
    paths: postMergeHookPaths,
    projectPath,
    id,
    logLabel: '[post-merge-hook]',
  });
}
