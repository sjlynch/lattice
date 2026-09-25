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
//   - nothing is ready_to_merge (In Progress checkouts can only be waited out);
//   - free space is under the merge floor (`MERGE_MIN_FREE_BYTES`) — such a run
//     can only halt on its first task, while writing to a nearly full disk;
//   - the Ready-to-Merge set is unchanged since the last run it started, i.e.
//     that run moved nothing (disk-halted, or every task errored/conflicted).
//     Re-running would do the same thing every throttle window forever, so it
//     holds until the set changes, free space drops under the floor and comes
//     back, or a backoff (15 min doubling to 2 h) expires.
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
import { mergeDiskSpaceShortfall } from './worktree/diskFull.js';

const THROTTLE_MS = 2 * 60_000;
const NO_PROGRESS_RETRY_MS = 15 * 60_000;
const NO_PROGRESS_RETRY_MAX_MS = 2 * 60 * 60_000;
const lastAttemptAt = new Map<string, number>();

// The last run this module started per project: the Ready-to-Merge set it was
// started for, when, and how many times in a row it was re-started for that
// same set (the backoff exponent).
type LastStartedRun = { readyKey: string; startedAt: number; retries: number; holdLogged: boolean };
const lastStartedRun = new Map<string, LastStartedRun>();

export type DiskPressureMergeOutcome =
  | 'started'
  | 'throttled'
  | 'disabled'
  | 'merge-run-active'
  | 'workflow-active'
  | 'hook-active'
  | 'nothing-to-merge'
  | 'disk-full'
  | 'no-progress'
  | 'failed';

export type DiskPressureMergeDeps = {
  autoMergeEnabled: () => Promise<boolean>;
  hasActiveMergeRun: (project: string) => boolean;
  hasActiveWorkflowRun: (project: string) => boolean;
  hasActivePostMergeHook: (project: string) => boolean;
  readyToMergeIds: (project: string) => Promise<string[]>;
  // Why a merge must not start now (under the merge floor), or null.
  mergeShortfall: (project: string) => Promise<string | null>;
  startMergeRun: (project: string, backendOrigin: string) => Promise<unknown>;
  now: () => number;
};

const defaultDeps: DiskPressureMergeDeps = {
  autoMergeEnabled: async () => (await getGlobalSettings()).autoMergeOnLowDisk !== false,
  hasActiveMergeRun: (p) => getActiveRunForProject(p) !== null,
  hasActiveWorkflowRun: (p) => getActiveWorkflowRuns(p).length > 0,
  hasActivePostMergeHook: (p) => !!getActiveHookForProject(p),
  readyToMergeIds: async (p) => (await listTasks(p)).filter((t) => t.status === 'ready_to_merge').map((t) => t.id),
  mergeShortfall: (p) => mergeDiskSpaceShortfall([p, homeWorktreesDir(p)]),
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
    const ready = await deps.readyToMergeIds(project);
    if (ready.length === 0) return 'nothing-to-merge';
    if (await deps.mergeShortfall(project)) {
      // Forget the last run: once space comes back above the floor, the tasks
      // a disk-halted run left behind are worth another try.
      lastStartedRun.delete(project);
      return 'disk-full';
    }
    const readyKey = [...ready].sort().join('\n');
    const prev = lastStartedRun.get(project);
    let retries = 0;
    if (prev && prev.readyKey === readyKey) {
      const backoff = Math.min(NO_PROGRESS_RETRY_MS * 2 ** prev.retries, NO_PROGRESS_RETRY_MAX_MS);
      if (now - prev.startedAt < backoff) {
        if (!prev.holdLogged) {
          prev.holdLogged = true;
          console.warn(
            `[disk] ${project}: the last merge run moved none of its ${ready.length} Ready-to-Merge task(s) — ` +
              `not starting another until they change, or in ${Math.round(backoff / 60_000)} min`,
          );
        }
        return 'no-progress';
      }
      retries = prev.retries + 1;
    }
    console.warn(
      `[disk] ${project}: ${reason} — starting a merge run of ` +
        `${ready.length} Ready-to-Merge task(s) to free their worktrees (global setting autoMergeOnLowDisk)`,
    );
    await deps.startMergeRun(project, backendOrigin);
    lastStartedRun.set(project, { readyKey, startedAt: now, retries, holdLogged: false });
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
// above (opt-out, nothing else merging, no workflow, throttled, never under
// the merge floor, no re-run of a run that moved nothing). Cheap when the
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
  lastStartedRun.clear();
  belowReserve.clear();
}
