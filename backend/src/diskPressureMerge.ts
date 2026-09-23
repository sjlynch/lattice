// Merge to free disk when task runs are waiting on it.
//
// A ready_to_merge task keeps its worktree (a full checkout) until it merges,
// so on a big repo parked tasks are what fills the disk — and the worktree
// disk guard (worktree/diskSpace.ts) then holds every further run in the spawn
// queue. When nothing else is going to merge them (a manual "Run All"), those
// runs would wait forever. So a disk deferral asks for a merge run of the
// project: the same `startMergeRun` the "Merge All" button uses. Each merged
// task's worktree cleanup then wakes the deferred runs
// (`notifyDiskSpaceFreed`).
//
// Deliberately narrow. It does nothing when:
//   - `globalSettings.autoMergeOnLowDisk === false` (opt-out);
//   - a merge run is already active for the project;
//   - a workflow run is active for the project — its own Merge control step
//     merges, and a second merge run would contend for the project run-lock;
//   - a post-merge hook is still running (same 409 the Merge All route gives);
//   - nothing is ready_to_merge (In Progress checkouts can only be waited out).
// Attempts are throttled per project, since every deferred run re-checks disk
// on its backoff.

import { canonicalProjectPath } from './projectPath.js';
import { getGlobalSettings } from './globalSettings.js';
import { listTasks } from './tasks.js';
import { getActiveRunForProject, startMergeRun } from './mergeRuns.js';
import { getActiveRunsForProject as getActiveWorkflowRuns } from './workflowRuns.js';
import { getActiveHookForProject } from './postMergeHooks.js';
import { requestWorktreeResidueSweep } from './recovery/worktreeResidueSweepLoop.js';

const THROTTLE_MS = 2 * 60_000;
const lastAttemptAt = new Map<string, number>();

export type DiskPressureMergeOutcome =
  | 'started'
  | 'throttled'
  | 'disabled'
  | 'merge-run-active'
  | 'workflow-active'
  | 'hook-active'
  | 'nothing-to-merge'
  | 'failed';

export type DiskPressureMergeDeps = {
  autoMergeEnabled: () => Promise<boolean>;
  hasActiveMergeRun: (project: string) => boolean;
  hasActiveWorkflowRun: (project: string) => boolean;
  hasActivePostMergeHook: (project: string) => boolean;
  countReadyToMerge: (project: string) => Promise<number>;
  startMergeRun: (project: string, backendOrigin: string) => Promise<unknown>;
  now: () => number;
};

const defaultDeps: DiskPressureMergeDeps = {
  autoMergeEnabled: async () => (await getGlobalSettings()).autoMergeOnLowDisk !== false,
  hasActiveMergeRun: (p) => getActiveRunForProject(p) !== null,
  hasActiveWorkflowRun: (p) => getActiveWorkflowRuns(p).length > 0,
  hasActivePostMergeHook: (p) => !!getActiveHookForProject(p),
  countReadyToMerge: async (p) => (await listTasks(p)).filter((t) => t.status === 'ready_to_merge').length,
  startMergeRun: (p, origin) => startMergeRun(p, origin),
  now: () => Date.now(),
};

export async function mergeToFreeDiskSpace(
  projectPath: string,
  backendOrigin: string,
  deps: DiskPressureMergeDeps = defaultDeps,
): Promise<DiskPressureMergeOutcome> {
  const project = canonicalProjectPath(projectPath);
  const now = deps.now();
  if (now - (lastAttemptAt.get(project) ?? -Infinity) < THROTTLE_MS) return 'throttled';
  lastAttemptAt.set(project, now);
  try {
    if (!(await deps.autoMergeEnabled())) return 'disabled';
    if (deps.hasActiveMergeRun(project)) return 'merge-run-active';
    if (deps.hasActiveWorkflowRun(project)) return 'workflow-active';
    if (deps.hasActivePostMergeHook(project)) return 'hook-active';
    const ready = await deps.countReadyToMerge(project);
    if (ready === 0) return 'nothing-to-merge';
    console.warn(
      `[disk] task runs in ${project} are waiting for disk space — starting a merge run of ` +
        `${ready} Ready-to-Merge task(s) to free their worktrees (global setting autoMergeOnLowDisk)`,
    );
    await deps.startMergeRun(project, backendOrigin);
    return 'started';
  } catch (err) {
    console.warn(`[disk] could not start a merge run to free disk space in ${project}:`, err);
    return 'failed';
  }
}

// Fire-and-forget form for the spawn path; never rejects. Also asks for a
// worktree residue pass (coalesced, all known projects): the leftovers of
// failed `git worktree remove`s are often what the disk is full of.
export function requestMergeToFreeDiskSpace(projectPath: string, backendOrigin: string): void {
  requestWorktreeResidueSweep();
  void mergeToFreeDiskSpace(projectPath, backendOrigin).catch(() => {});
}

// Test seam.
export function resetDiskPressureMergeStateForTests(): void {
  lastAttemptAt.clear();
}
