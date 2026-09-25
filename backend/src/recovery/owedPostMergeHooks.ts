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
//
// The run-lock check is the backstop for the active-merge-run one. The merge
// resume awaits `startMergeRun` up to registration, but a project whose
// run.lock is still held (a live owner — another process, or a run that
// registered under a path variant) or still stale-resumable (the resume
// skipped or failed to start it) is mid-merge by definition: a hook agent
// started now would edit the main checkout under that merge's snapshot/reset,
// and the merge's own teardown fires the hook once it lands. So is one whose
// dead run lock boot snapshot recovery retired and recorded as an
// interrupted-run marker (projectRunLock/interruptedRun.ts) that the resume
// did not clear.

import { getActiveRunForProject } from '../mergeRuns.js';
import { inspectProjectRunLock } from '../projectRunLock.js';
import { getActiveRunsForProject as getActiveWorkflowRunsForProject } from '../workflowRuns.js';
import { runPostMergeHookGate } from '../postMergeHooks.js';
import { isPostMergeHookOwed } from '../postMergeHooks/owed.js';
import { isResumableInterruptedRunLock } from './mergeRunResume.js';
import { readInterruptedRun } from '../projectRunLock/interruptedRun.js';
import { forEachKnownProjectSafely } from './projectIteration.js';

export type FireOwedPostMergeHooksDeps = {
  getActiveRunForProject: typeof getActiveRunForProject;
  inspectProjectRunLock: typeof inspectProjectRunLock;
  runPostMergeHookGate: typeof runPostMergeHookGate;
  // Optional so existing callers keep compiling; defaults to the real reader.
  readInterruptedRun?: typeof readInterruptedRun;
};

const productionDeps: FireOwedPostMergeHooksDeps = {
  getActiveRunForProject,
  inspectProjectRunLock,
  runPostMergeHookGate,
  readInterruptedRun,
};

export async function fireOwedPostMergeHooks(
  backendOrigin: string,
  deps: FireOwedPostMergeHooksDeps = productionDeps,
): Promise<void> {
  await forEachKnownProjectSafely('owed post-merge hooks', async (projectPath) => {
    if (!(await isPostMergeHookOwed(projectPath))) return;
    if (deps.getActiveRunForProject(projectPath)) return;
    if (getActiveWorkflowRunsForProject(projectPath).length > 0) return;
    const lock = await deps.inspectProjectRunLock(projectPath);
    if (lock && (lock.alive || isResumableInterruptedRunLock(lock.holder.label))) {
      console.log(
        `[startup] owed post-merge hook for ${projectPath} deferred — its run lock ("${lock.holder.label}", ` +
          `${lock.alive ? 'held' : 'stale, resumable'}) says a merge is in flight; that merge fires it.`,
      );
      return;
    }
    const interrupted = await (deps.readInterruptedRun ?? readInterruptedRun)(projectPath);
    if (interrupted) {
      console.log(
        `[startup] owed post-merge hook for ${projectPath} deferred — an interrupted "${interrupted.label}" run ` +
          'still has to resume; that merge fires it.',
      );
      return;
    }
    console.log(`[startup] a merge before the restart still owes its post-merge hook — firing it for ${projectPath}`);
    // Not awaited per project: the gate blocks until the hook agent finishes.
    void deps.runPostMergeHookGate({ projectPath, backendOrigin, trigger: 'merge-run' }).catch((err) =>
      console.warn(`[startup] owed post-merge hook for ${projectPath} failed:`, err),
    );
  });
}
