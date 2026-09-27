// `waitForLaneEmpty` — the push step's lane drain (re-exported from shared.ts).

import { listTasks, subscribe as subscribeTasks } from '../../tasks.js';
import type { Task, TaskStatus } from '../../tasks.js';
import { subscribe, type WorkflowRun } from '../state.js';
import { createUnrefTimer, createWaitSettler, isRunEndedEvent } from './waitPrimitives.js';

// The task-store / workflow-run subscriptions `waitForLaneEmpty` leans on,
// injectable so the timeout behaviour can be unit-tested against a lane that
// never empties without touching the real stores (Fix 2 regression test).
export type LaneWaitDeps = {
  listTasks: typeof listTasks;
  subscribeTasks: typeof subscribeTasks;
  subscribeRun: typeof subscribe;
};

export const productionLaneWaitDeps: LaneWaitDeps = {
  listTasks,
  subscribeTasks,
  subscribeRun: subscribe,
};

// Resolve when the given lane on `projectPath` is empty (count === 0) OR the
// workflow run is no longer 'running'. Snapshots `total` on first observation
// so progress reporting has a stable denominator.
//
// Subscribes to the task store BEFORE doing the initial read so we don't miss
// a transition that happens between read and subscribe. Also subscribes to
// workflow-run events so cancellation resolves the wait promptly (otherwise
// the lock would be held until something else nudges the task store).
//
// BOUNDED WAIT — a NO-PROGRESS timeout (not a total one). When `maxWaitMs` is
// set, the returned promise REJECTS only after the lane goes `maxWaitMs` WITHOUT
// a single task leaving it; every drain re-arms the deadline. A lane can
// legitimately never empty — a task whose agent died without committing is
// refused auto-completion by the in-progress sweep (`no-commits` → skip), so it
// sits there forever — and that genuinely-stuck case still trips the timeout and
// lets the worker's catch mark the run errored and release the cross-process
// project run-lock (`~/.lattice/per-project/<hash>/run.lock`), which an unbounded
// wait would leak forever (blocking all future merge runs / control steps and
// making dev.mjs defer restarts indefinitely).
//
// The distinction matters: a *fixed total* timeout erroring a lane that is
// steadily draining strands a whole workflow's completed work. That is the bug
// this fixed — the Merge step's Phase A 30-min wall clock fired ~5s before the
// last of 29 codex tasks finished, so Phase B never merged and all 29 completed
// tasks were left at ready_to_merge. A no-progress timer keeps waiting as long as
// tasks keep finishing, however long that takes in total. Callers that pass no
// `maxWaitMs` keep the old unbounded behaviour.
export function waitForLaneEmpty(
  projectPath: string,
  run: WorkflowRun,
  laneStatus: TaskStatus,
  onProgress: (count: number, total: number) => void,
  maxWaitMs?: number,
  deps: LaneWaitDeps = productionLaneWaitDeps,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let total = 0;
    let totalCaptured = false;
    let lastCount = 0;
    // Lowest lane count seen so far. The timeout below is re-armed every time
    // the count drops BELOW this floor — i.e. every time a task actually leaves
    // the lane — so it measures "time since the lane last made progress", not
    // total elapsed time. A steadily-draining lane never trips it; only a lane
    // that stalls (a dead agent that never commits) does.
    let progressFloor = Number.POSITIVE_INFINITY;
    let unsubTasks: (() => void) | null = null;
    let unsubRun: (() => void) | null = null;

    // The no-progress backstop, absent when the wait is unbounded. Armed on the
    // first observation and re-armed every time a task leaves the lane, so a
    // lane that keeps draining — however slowly, and however long it takes in
    // total — never trips it.
    const timer = maxWaitMs === undefined || maxWaitMs <= 0
      ? null
      : createUnrefTimer(maxWaitMs, () => {
        fail(
          new Error(
            `waitForLaneEmpty: lane "${laneStatus}" made no progress for ` +
              `${maxWaitMs}ms (${lastCount} task(s) still present) — aborting so ` +
              `the project run-lock is released`,
          ),
        );
      });

    const { finish, fail, settled } = createWaitSettler<void>({
      resolve,
      reject,
      cleanup: () => {
        unsubTasks?.();
        unsubRun?.();
        timer?.clear();
      },
    });

    const evaluate = (tasks: Task[]): boolean => {
      const count = tasks.filter((t) => t.status === laneStatus).length;
      lastCount = count;
      if (!totalCaptured) {
        total = Math.max(count, 1);
        totalCaptured = true;
      }
      // Forward progress (the first observation, or a task drained) → the lane
      // is alive; reset the no-progress deadline.
      if (count < progressFloor) {
        progressFloor = count;
        timer?.arm();
      }
      onProgress(count, total);
      return count === 0 || run.status !== 'running';
    };

    // Subscribe FIRST so a change between the initial listTasks and our
    // subscribe doesn't slip past us.
    unsubTasks = deps.subscribeTasks((proj, tasks) => {
      if (settled() || proj !== projectPath) return;
      try {
        if (evaluate(tasks)) finish();
      } catch (err) {
        fail(err);
      }
    });
    // Workflow-run cancellation: resolve the wait so the worker can exit
    // the control step (and release the project run-lock) promptly.
    unsubRun = deps.subscribeRun((ev) => {
      if (isRunEndedEvent(ev, run.id)) finish();
    });

    // Bound the initial read too. In particular, a rejected task-store read
    // must reject THIS waiter so its worker releases run.lock; an unobserved
    // .then rejection instead reaches processGuards and kills the backend.
    timer?.arm();
    try {
      void deps.listTasks(projectPath).then((initial) => {
        if (settled()) return;
        if (evaluate(initial)) finish();
      }).catch(fail);
    } catch (err) {
      fail(err);
    }
  });
}
