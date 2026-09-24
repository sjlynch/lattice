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
//
// Two triggers: a task run deferred for disk (the spawn path), and the
// low-disk monitor below — free space under the reserve with nothing waiting.
// The second exists because of 2026-09-24: 22 Ready-to-Merge worktrees sat on
// a disk that other writers then filled to zero, and nothing merged them until
// a merge run started with no space left and failed all 22.

import { canonicalProjectPath, homeWorktreesDir } from './projectPath.js';
import { getGlobalSettings } from './globalSettings.js';
import { listTasks } from './tasks.js';
import { getActiveRunForProject, startMergeRun } from './mergeRuns.js';
import { getActiveRunsForProject as getActiveWorkflowRuns } from './workflowRuns.js';
import { getActiveHookForProject } from './postMergeHooks.js';
import { requestWorktreeResidueSweep } from './recovery/worktreeResidueSweepLoop.js';
import { forEachKnownProjectSafely } from './recovery/projectIteration.js';
import { formatBytes, freeBytesAt, minFreeDiskBytes } from './worktree/diskSpace.js';

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
  reason = 'task runs are waiting for disk space',
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
      `[disk] ${project}: ${reason} — starting a merge run of ` +
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

// ---------------------------------------------------------------------------
// Low-disk monitor: once a minute, for every known project whose worktree
// volume has less free space than the reserve (globalSettings minFreeDiskGb),
// ask for a merge run of its Ready-to-Merge tasks — the same narrow rules as
// above (opt-out, nothing else merging, no workflow, throttled). Cheap when the
// disk is fine: one statfs per project and nothing else.
// ---------------------------------------------------------------------------

export const LOW_DISK_MONITOR_INTERVAL_MS = 60_000;

export type LowDiskMonitorDeps = {
  forEachProject: (fn: (projectPath: string) => Promise<void>) => Promise<void>;
  freeBytesAt: (target: string) => Promise<number | null>;
  minFreeBytes: () => Promise<number>;
  requestMerge: (projectPath: string, reason: string) => Promise<DiskPressureMergeOutcome>;
};

const belowReserve = new Set<string>();

export async function checkLowDiskOnce(deps: LowDiskMonitorDeps): Promise<void> {
  const reserve = await deps.minFreeBytes();
  await deps.forEachProject(async (projectPath) => {
    const project = canonicalProjectPath(projectPath);
    const free = await deps.freeBytesAt(homeWorktreesDir(project));
    if (free === null || free >= reserve) {
      belowReserve.delete(project);
      return;
    }
    if (!belowReserve.has(project)) {
      belowReserve.add(project);
      console.warn(
        `[disk] only ${formatBytes(free)} free for ${project}'s worktrees (reserve ${formatBytes(reserve)}) — ` +
          'merging its Ready-to-Merge tasks to free their worktrees when nothing else is',
      );
    }
    await deps.requestMerge(project, `only ${formatBytes(free)} free (reserve ${formatBytes(reserve)})`);
  });
}

let monitorTimer: NodeJS.Timeout | null = null;
let monitorInFlight = false;

export function startLowDiskMonitor(backendOrigin: string, intervalMs = LOW_DISK_MONITOR_INTERVAL_MS): void {
  if (monitorTimer) return;
  const deps: LowDiskMonitorDeps = {
    forEachProject: (fn) => forEachKnownProjectSafely('lowDiskMonitor', fn),
    freeBytesAt,
    minFreeBytes: minFreeDiskBytes,
    requestMerge: (project, reason) => mergeToFreeDiskSpace(project, backendOrigin, defaultDeps, reason),
  };
  monitorTimer = setInterval(() => {
    if (monitorInFlight) return;
    monitorInFlight = true;
    void checkLowDiskOnce(deps)
      .catch((err) => console.warn('[disk] low-disk check failed:', err))
      .finally(() => { monitorInFlight = false; });
  }, intervalMs);
  monitorTimer.unref?.();
}

export function stopLowDiskMonitor(): void {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}

// Test seam.
export function resetDiskPressureMergeStateForTests(): void {
  lastAttemptAt.clear();
  belowReserve.clear();
}
