import { cleanupHomeScratchSession } from '../homeScratch/cleanup.js';
import { pushPaths } from './paths.js';

// Bounded recursive delete of a push session's home-scoped scratch dir. Thin
// wrapper over the shared `cleanupHomeScratchSession` (the same guarded delete
// QA runs use): kill the PTY holding the dir handle, strip reparse points, then
// `fsRmWithRetries`, all gated through `assertSafePushSessionPath` +
// `assertNotReparsePoint`. On failure it leaves the dir for the boot sweep
// (`sweepOrphanedPushSessions`).
export function cleanupPushSession(
  projectPath: string,
  id: string,
): Promise<void> {
  return cleanupHomeScratchSession({
    paths: pushPaths,
    projectPath,
    id,
    logLabel: '[pushRuns]',
  });
}
