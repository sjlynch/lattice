import { getActiveRunForProject } from '../../../mergeRuns.js';
import { runPostMergeHookGate } from '../../../postMergeHooks.js';
import { waitForExclusiveProjectHold } from '../../../projectRunLock.js';

// Resolver-finished tasks transition to qa, which counts as a "merge" for
// the purposes of the post-merge hook. Skip when a merge run is active: the
// run owns its own end-of-run hook fire, and double-firing would deadlock
// the run on its own gate (the per-task await holds the gate, the run can't
// reach finishRun until it returns).
//
// Shared by /complete (resolver branch), /merged, and /stash-resolved.
export async function awaitPostMergeHookOutsideRun(
  projectPath: string,
  backendOrigin: string,
): Promise<void> {
  if (getActiveRunForProject(projectPath)) return;
  try {
    // A workflow Run tests step holds the project exclusively while its agent
    // works on the main checkout; a hook agent started now would run alongside
    // it on the same tree. Defer until the step releases (a no-op otherwise).
    await waitForExclusiveProjectHold(projectPath);
    await runPostMergeHookGate({
      projectPath,
      backendOrigin,
      trigger: 'manual-merge',
    });
  } catch (err) {
    console.warn(
      '[task-hook] post-merge hook gate threw (continuing):',
      err,
    );
  }
}
