// Pure state transitions + constants for `useWorkflowRuns`. Extracting these
// keeps the hook's effect a thin wiring layer over testable, side-effect-free
// reducers — the tricky invariants (additive fetch reconciliation, "hello is
// authoritative", stale control-progress cleanup) live here where they can be
// reasoned about and unit-tested in isolation.

import type {
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepKind,
} from '../../../api';

// Latest progress snapshot for a control-flow step. Keyed by runId; only the
// currently-executing step's progress is retained (next step replaces it).
export type ControlProgress = {
  stepIndex: number;
  kind: WorkflowStepKind;
  current: number;
  total: number;
  message?: string;
};

export type RunMap = Record<string, WorkflowRun>;
export type ControlProgressMap = Record<string, ControlProgress>;

// Recent-run linger windows. Completed runs disappear quickly (10s) so the
// chip area stays uncluttered, but errored/cancelled runs linger long enough
// (5min) that a user who stepped away from the screen still sees the failure
// signal when they return. Both can be dismissed manually via `dismissRecent`.
export const COMPLETED_LINGER_MS = 10_000;
export const ERRORED_LINGER_MS = 5 * 60 * 1000;

// Re-fetch the active-runs HTTP endpoint when this fraction of stale time has
// passed since the last fetch on visibility return. Cheap belt-and-braces in
// case a WS event was lost while the tab was hidden — additive only, so a
// stale fetch can't remove a run.
export const VISIBILITY_REFETCH_MIN_INTERVAL_MS = 2000;

// `hello` is the authoritative server snapshot — build the activeRuns map from
// scratch so it replaces local state entirely (also the post-reconnect
// recovery path).
export function activeRunsFromHello(runs: WorkflowRun[]): RunMap {
  const map: RunMap = {};
  for (const r of runs) map[r.id] = r;
  return map;
}

// A `recovering` hello (backend restarted, persisted runs not re-registered
// yet) is a PARTIAL snapshot: upsert what it carries, remove nothing. Same
// reference when it adds nothing new, so React can skip the re-render.
export function mergeRecoveringHello(cur: RunMap, runs: WorkflowRun[]): RunMap {
  if (runs.length === 0) return cur;
  const next = { ...cur };
  for (const r of runs) next[r.id] = r;
  return next;
}

// `started` / `progress` upsert the freshest run snapshot.
export function upsertRun(cur: RunMap, run: WorkflowRun): RunMap {
  return { ...cur, [run.id]: run };
}

// A step advance ('progress' fires after step-spawned for agent steps) makes
// whatever control-progress we showed for the prior step stale. Drop it; the
// next step's first progress event will replace it. No-op (same ref) if the
// step index is unchanged or nothing was tracked.
export function clearStaleControlProgress(
  cur: ControlProgressMap,
  runId: string,
  currentStepIndex: number,
): ControlProgressMap {
  const prev = cur[runId];
  if (!prev || prev.stepIndex === currentStepIndex) return cur;
  return removeKey(cur, runId);
}

// An agent step's pre-run tool progress ("running the Opengrep scan before the
// agent starts…") ends the moment that step's terminal spawns. Nothing else
// clears it — the run's `currentStepIndex` does not move until the step
// completes — so `step-spawned` drops the entry when it belongs to that step.
// Progress for a different step (a stale event) is left alone.
export function clearControlProgressForStep(
  cur: ControlProgressMap,
  runId: string,
  stepIndex: number,
): ControlProgressMap {
  const prev = cur[runId];
  if (!prev || prev.stepIndex !== stepIndex) return cur;
  return removeKey(cur, runId);
}

// Delete a key from a map, returning the same reference when absent so React
// can skip the re-render. Used for active/recent run and control-progress
// removal alike.
export function removeKey<T>(
  cur: Record<string, T>,
  id: string,
): Record<string, T> {
  if (!(id in cur)) return cur;
  const next = { ...cur };
  delete next[id];
  return next;
}

// Stash a finalized run in the recent-runs map (linger before auto-dismissal).
export function addRecentRun(cur: RunMap, run: WorkflowRun): RunMap {
  return { ...cur, [run.id]: run };
}

// Replace the tracked control-progress for a run with the latest snapshot.
export function setControlProgress(
  cur: ControlProgressMap,
  ev: {
    runId: string;
    stepIndex: number;
    kind: WorkflowStepKind;
    current: number;
    total: number;
    message?: string;
  },
): ControlProgressMap {
  return {
    ...cur,
    [ev.runId]: {
      stepIndex: ev.stepIndex,
      kind: ev.kind,
      current: ev.current,
      total: ev.total,
      message: ev.message,
    },
  };
}

// Additive reconciler: merge `fetched` into `cur` without removing anything. A
// run already in `recent` was finalized by a WS event we saw — don't resurrect
// it from a (possibly stale) fetch. Returns the new map plus the ids that were
// actually added, for logging.
export function mergeFetchedActiveRuns(
  cur: RunMap,
  recent: RunMap,
  fetched: WorkflowRun[],
): { next: RunMap; addedIds: string[] } {
  const addedIds: string[] = [];
  const next = { ...cur };
  for (const r of fetched) {
    if (next[r.id]) continue;
    if (recent[r.id]) continue;
    next[r.id] = r;
    addedIds.push(r.id);
  }
  return { next, addedIds };
}

// Status-dependent linger before a recent run auto-dismisses.
export function recentDismissalDelayMs(status: WorkflowRunStatus): number {
  return status === 'completed' ? COMPLETED_LINGER_MS : ERRORED_LINGER_MS;
}
