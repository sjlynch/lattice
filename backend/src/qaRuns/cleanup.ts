import { cleanupHomeScratchSession } from '../homeScratch/cleanup.js';
import { qaPaths } from './paths.js';

// Bounded recursive delete of a QA session's home-scoped scratch dir. Thin
// wrapper over the shared `cleanupHomeScratchSession` (mirrors pushRuns): kill
// the PTY holding the dir handle, strip reparse points, then `fsRmWithRetries`,
// all gated through `assertSafeQaSessionPath` + `assertNotReparsePoint`. On
// failure it leaves the dir for the boot sweep (`sweepOrphanedQaSessions`).
export function cleanupQaSession(
  projectPath: string,
  id: string,
): Promise<void> {
  return cleanupHomeScratchSession({
    paths: qaPaths,
    projectPath,
    id,
    logLabel: '[qaRuns]',
  });
}
