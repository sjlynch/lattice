import type { Response } from 'express';
import {
  isMidMerge,
  ensureLatticeRepoExclude,
  untrackOwnedFilesInRepo,
  resyncWithMainAndFinalize,
  type ResyncOutcome,
} from '../../worktree.js';
import {
  acquireProjectRunLock,
  ProjectRunLockedError,
  type ProjectRunLockHandle,
} from '../../projectRunLock.js';
import { getActiveRunForProject } from '../../mergeRuns.js';
import { runPostMergeHookGate } from '../../postMergeHooks.js';
import { logTaskRouteError } from './_shared.js';
import {
  clearProjectManualMergeActive,
  markProjectManualMergeActive,
} from './manualMergeGuards.js';
import type { MergeReadyTask } from './manualMergeTypes.js';
import {
  respondExistingConflictInstructions,
  respondMergeOutcome,
} from './mergeResponses.js';

// If the manual merge actually transitioned the task to qa, gate the
// HTTP response on the post-merge hook so the UI (and any workflow waiting
// on the merge step) sees "merged" only after the hook agent has run. A
// merge run owns its own end-of-run hook fire, so skip if one is active.
async function awaitPostMergeHookIfFinalized(
  task: MergeReadyTask,
  outcome: ResyncOutcome,
  backendOrigin: string,
): Promise<void> {
  if (outcome.kind !== 'finalized') return;
  if (getActiveRunForProject(task.projectPath)) return;
  try {
    await runPostMergeHookGate({
      projectPath: task.projectPath,
      backendOrigin,
      trigger: 'manual-merge',
    });
  } catch (err) {
    console.warn(
      '[merge] post-merge hook gate threw (returning merged anyway):',
      err,
    );
  }
}

async function handleAlreadyConflictedMerge(
  task: MergeReadyTask,
  backendOrigin: string,
  res: Response,
): Promise<Response> {
  if (!(await isMidMerge(task.worktreePath))) {
    const outcome = await resyncWithMainAndFinalize(task, backendOrigin);
    // A re-sync error here falls back to returning the existing resolver
    // instructions, matching the old manual /merge behavior.
    if (!(outcome.kind === 'error' && outcome.phase === 'merge')) {
      await awaitPostMergeHookIfFinalized(task, outcome, backendOrigin);
      return respondMergeOutcome(res, task, outcome);
    }
  }
  return respondExistingConflictInstructions(res, task, backendOrigin);
}

async function runFreshMerge(
  task: MergeReadyTask,
  backendOrigin: string,
  res: Response,
): Promise<Response> {
  const outcome = await resyncWithMainAndFinalize(task, backendOrigin);
  await awaitPostMergeHookIfFinalized(task, outcome, backendOrigin);
  return respondMergeOutcome(res, task, outcome);
}

export async function runManualMerge(
  task: MergeReadyTask,
  backendOrigin: string,
  res: Response,
  deps = { handleAlreadyConflictedMerge, runFreshMerge },
): Promise<Response> {
  // Cross-process lock: another Lattice process (e.g. the user opened
  // this project in two Lattice instances, or has Lattice running on
  // its own repo while a sibling project is merging) could otherwise
  // race us through git status / snapshot / FF. The in-process gates
  // above only see this process's state.
  let projectLock: ProjectRunLockHandle;
  try {
    projectLock = await acquireProjectRunLock(task.projectPath, 'manual-merge');
  } catch (err) {
    if (err instanceof ProjectRunLockedError) {
      return res.status(409).json({ error: err.message });
    }
    return res.status(500).json({ error: (err as Error).message });
  }

  markProjectManualMergeActive(task.projectPath);

  try {
    // Heal the project's tracking of Lattice-owned files before merging.
    // Idempotent no-op when nothing is tracked. See untrackOwnedFilesInRepo.
    //
    // Deliberately NO ensureLatticeGitignore call here — modifying the
    // tracked .gitignore mid-merge dirties the working tree and (as the
    // 2026-05-08/09 incident postmortems showed) creates a path where a
    // lost stash can silently delete .git/, .lattice/tasks.json, etc.
    // setupTaskWorktree applies the .gitignore once per project at
    // worktree-create time, so it's already in place by the time the
    // user clicks Merge.
    try {
      await ensureLatticeRepoExclude(task.projectPath);
      await untrackOwnedFilesInRepo(task.projectPath);
    } catch (err) {
      console.warn('[merge] pre-flight untrack failed (continuing):', err);
    }

    // If already in a known conflict state, check whether the conflict was
    // already committed. When a resolver Claude finishes but
    // finalizeMergedTask fails (e.g. a race where another task's finalize
    // ran first and advanced main), the worktree has a clean merge commit
    // but the task is still at ready_to_merge + conflict: true. Detect
    // this by checking isMidMerge: if the worktree is NOT mid-merge, the
    // resolver already committed — re-sync with current main and finalize.
    if (task.conflict) {
      return await deps.handleAlreadyConflictedMerge(task, backendOrigin, res);
    }

    // Keep the lock until the merge promise settles. Returning it without
    // awaiting runs finally immediately and releases main to another merger.
    return await deps.runFreshMerge(task, backendOrigin, res);
  } catch (err) {
    logTaskRouteError(task, 'merge', err);
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    clearProjectManualMergeActive(task.projectPath);
    await projectLock.release();
  }
}
