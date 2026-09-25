// Boot: fire a post-merge hook a pre-restart merge still owes
// (postMergeHooks/owed.ts), for a project where nothing else will.
//
// Runs AFTER the workflow + merge-run resumes: a project that now has an
// active merge run fires it from that run's teardown (it honours the marker),
// and one with an active workflow run is left to the workflow — its Merge
// step's Phase C fires it, and firing here would put a hook agent on the main
// checkout alongside whatever step the workflow is on. What is left is the
// project whose merge landed (a merge-all's last task, a manual merge, a
// resolver finalize) and whose backend died before the hook fired: nothing
// would ever run it again.

import { getActiveRunForProject } from '../mergeRuns.js';
import { getActiveRunsForProject as getActiveWorkflowRunsForProject } from '../workflowRuns.js';
import { runPostMergeHookGate } from '../postMergeHooks.js';
import { isPostMergeHookOwed } from '../postMergeHooks/owed.js';
import { forEachKnownProjectSafely } from './projectIteration.js';

export async function fireOwedPostMergeHooks(backendOrigin: string): Promise<void> {
  await forEachKnownProjectSafely('owed post-merge hooks', async (projectPath) => {
    if (!(await isPostMergeHookOwed(projectPath))) return;
    if (getActiveRunForProject(projectPath)) return;
    if (getActiveWorkflowRunsForProject(projectPath).length > 0) return;
    console.log(`[startup] a merge before the restart still owes its post-merge hook — firing it for ${projectPath}`);
    // Not awaited per project: the gate blocks until the hook agent finishes.
    void runPostMergeHookGate({ projectPath, backendOrigin, trigger: 'merge-run' }).catch((err) =>
      console.warn(`[startup] owed post-merge hook for ${projectPath} failed:`, err),
    );
  });
}
