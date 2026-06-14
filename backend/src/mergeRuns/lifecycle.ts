// Run-startup helpers for the merge-all engine: lock acquisition + active-run
// (409) detection, ready_to_merge target selection, and the run record.
//
// startMergeRun (../mergeRuns.ts) is a thin orchestrator over these. Keeping
// the setup here isolates the in-process / cross-process gates and the target
// filter that the .git-deletion and re-runnable invariants depend on, so the
// orchestrator reads as: init → filter → record → loop → teardown.

import { canonicalProjectPath } from '../projectPath.js';
import {
  acquireProjectRunLock,
  ProjectRunLockedError,
  type ProjectRunLockHandle,
} from '../projectRunLock.js';
import { generateMergeRunId } from '../ids.js';
import type { Task } from '../tasks.js';
import type { MergeRunLockMode } from '../mergeRuns.js';
import type { MergeRun, RunState } from './state.js';

export type InitializedRunState = {
  // Canonicalized project path — callers should use this for everything that
  // follows so the run record and the lock key agree.
  projectPath: string;
  // Held cross-process lock to release in the worker's finally, or null when
  // lockMode === 'inherit' (the caller owns the lock).
  projectLock: ProjectRunLockHandle | null;
};

// Canonicalize the path, load persisted runs, reject a concurrent run, and
// acquire the cross-process project run-lock. Throws on either gate so the
// route surfaces it as a 409 / error before any run record exists.
export async function initializeRunState(
  state: RunState,
  projectPath: string,
  lockMode: MergeRunLockMode,
): Promise<InitializedRunState> {
  projectPath = canonicalProjectPath(projectPath);
  await state.loadProject(projectPath);

  // In-process gate: one active run per project. A second start returns 409.
  for (const r of state.runs.values()) {
    if (r.projectPath === projectPath && r.status === 'running') {
      throw new Error('A merge run is already in progress for this project.');
    }
  }

  // Cross-process gate. If another Lattice process is already merging
  // this project (the lattice-on-lattice scenario, or two sibling
  // installations sharing a repo), bail before we begin: holding a stale
  // run object plus running snapshot/FF concurrently with a sibling
  // process is the configuration that produced prior `.git` deletions.
  //
  // When lockMode is 'inherit' (workflow Merge control step), the caller
  // already holds the lock for the whole step — skip both acquire and
  // release here so we don't deadlock or release someone else's lock.
  let projectLock: ProjectRunLockHandle | null = null;
  if (lockMode !== 'inherit') {
    try {
      projectLock = await acquireProjectRunLock(projectPath, 'merge-run');
    } catch (err) {
      if (err instanceof ProjectRunLockedError) {
        throw new Error(err.message);
      }
      throw err;
    }
  }

  return { projectPath, projectLock };
}

// Select and order the tasks a run will process.
//
// Include conflict-flagged tasks too — the per-task loop knows how to
// re-attempt them (resolver Claude may have already finished and
// committed; Lattice just needs to re-sync and finalize). The old
// `&& !t.conflict` filter stranded conflict tasks across server
// restarts: a "merge all" click would skip them entirely. Ordering is
// createdAt-ascending and must not change (merge ordering invariant).
export function filterAndSortTargets(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.status === 'ready_to_merge')
    .sort((a, b) => a.createdAt - b.createdAt);
}

// Build the in-memory run record. The caller is responsible for registering it
// in the run map and emitting the 'started' event.
export function createRunRecord(targets: Task[], projectPath: string): MergeRun {
  return {
    id: generateMergeRunId(),
    projectPath,
    status: 'running',
    startedAt: Date.now(),
    total: targets.length,
    processed: 0,
    merged: [],
    conflicted: [],
    errored: [],
    cancelRequested: false,
  };
}
