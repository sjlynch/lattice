// What happened to a run that left `activeRuns` WITHOUT a terminal WS event?
//
// A real completed/errored/cancelled event always records the run in
// `recentRuns` before removing it, so a run that just disappears came out of a
// `hello` full-replace. That has three very different causes:
//   1. the socket reconnected to a backend that is still re-registering its
//      persisted runs after a restart — the run comes back a moment later;
//   2. the run FINISHED while this tab's socket was down (sleep, restart),
//      so its terminal event was never delivered;
//   3. the backend genuinely lost the run.
// Reading all three as 'errored' (the old behaviour) stopped the workflow
// queue on every Lattice self-merge restart. So instead: wait a short grace
// (1), then ask the backend for the run by id — its recorded final status
// answers (2), a 404 is (3) → 'errored'. A backend that can't be reached is
// asked again on a backoff, up to a cap.

import type { WorkflowRun, WorkflowRunStatus } from '../../../api';

export const VANISHED_RUN_GRACE_MS = 3_000;
export const VANISHED_RUN_RETRY_MS = 5_000;
// Poll interval while the backend says the run is still running even though
// this tab's map dropped it (a missed re-add); a `progress` event or the next
// hello normally ends this first.
export const VANISHED_RUN_STILL_RUNNING_POLL_MS = 10_000;
// Give up asking an unreachable backend after this long and treat the run as
// lost (the old behaviour, just no longer instant).
export const VANISHED_RUN_MAX_UNREACHABLE_MS = 3 * 60_000;

export type VanishedRunDeps = {
  // The run is back in `activeRuns` — nothing finished.
  isActive: () => boolean;
  // A terminal WS event recorded it after all.
  recentStatus: () => WorkflowRunStatus | undefined;
  // GET the run: `null` = 404 (unknown to the backend); throws = couldn't ask.
  fetchRun: () => Promise<WorkflowRun | null>;
  // Project switched / unmounted — stop without reporting.
  isCancelled: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Resolves the status to report via `runFinished`, or `null` when nothing
// should be reported (the run came back, or the resolution was cancelled).
export async function resolveVanishedRun(deps: VanishedRunDeps): Promise<WorkflowRunStatus | null> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let delay = VANISHED_RUN_GRACE_MS;
  for (;;) {
    await sleep(delay);
    if (deps.isCancelled() || deps.isActive()) return null;
    const recent = deps.recentStatus();
    if (recent) return recent;

    let run: WorkflowRun | null;
    try {
      run = await deps.fetchRun();
    } catch {
      if (now() - startedAt >= VANISHED_RUN_MAX_UNREACHABLE_MS) {
        return deps.isCancelled() ? null : 'errored';
      }
      delay = VANISHED_RUN_RETRY_MS;
      continue;
    }
    if (deps.isCancelled() || deps.isActive()) return null;
    const recentAfter = deps.recentStatus();
    if (recentAfter) return recentAfter;
    if (!run) return 'errored';
    if (run.status !== 'running') return run.status;
    delay = VANISHED_RUN_STILL_RUNNING_POLL_MS;
  }
}
