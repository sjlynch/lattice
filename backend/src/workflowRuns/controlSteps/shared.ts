// Shared helpers for the control-step workers (start / merge / push).
//
// `waitForLaneEmpty` is the lane-drain subscription used by both the merge
// and push steps; `emitControlProgress` is the single place that shapes the
// `step-control-progress` WS payload so every worker reports progress the
// same way.

import { listTasks, subscribe as subscribeTasks } from '../../tasks.js';
import type { Task, TaskStatus } from '../../tasks.js';
import type { WorkflowStepKind } from '../../workflows.js';
import { notify, subscribe, type WorkflowRun } from '../state.js';

// The task-store / workflow-run subscriptions `waitForLaneEmpty` leans on,
// injectable so the timeout behaviour can be unit-tested against a lane that
// never empties without touching the real stores (Fix 2 regression test).
export type LaneWaitDeps = {
  listTasks: typeof listTasks;
  subscribeTasks: typeof subscribeTasks;
  subscribeRun: typeof subscribe;
};

const productionLaneWaitDeps: LaneWaitDeps = {
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
// BOUNDED WAIT (Fix 2): when `maxWaitMs` is set, the returned promise REJECTS
// if the lane hasn't drained by then. A lane can legitimately never empty — a
// task in it whose agent died without committing is refused auto-completion by
// the in-progress sweep (`no-commits` → skip), so it sits there forever. The
// merge/push control-step worker awaits this; an unbounded wait would hang the
// worker, and its `finally` never runs, so the cross-process project run-lock
// (`~/.lattice/per-project/<hash>/run.lock`) is held forever — blocking all
// future merge runs / workflow control steps for the project (and dev.mjs keeps
// deferring backend restarts while the lock is held). Rejecting on expiry lets
// the worker's catch mark the run errored and release the lock. Callers that
// pass no `maxWaitMs` keep the old unbounded behaviour.
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
    let settled = false;
    let lastCount = 0;
    let unsubTasks: (() => void) | null = null;
    let unsubRun: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      unsubTasks?.();
      unsubRun?.();
      if (timer) clearTimeout(timer);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const evaluate = (tasks: Task[]): boolean => {
      const count = tasks.filter((t) => t.status === laneStatus).length;
      lastCount = count;
      if (!totalCaptured) {
        total = Math.max(count, 1);
        totalCaptured = true;
      }
      onProgress(count, total);
      return count === 0 || run.status !== 'running';
    };

    // Bounded backstop: reject if the lane never drains. Set up before the
    // subscriptions/initial read so a synchronous drain still wins (finish()
    // clears the timer).
    if (maxWaitMs !== undefined && maxWaitMs > 0) {
      timer = setTimeout(() => {
        fail(
          new Error(
            `waitForLaneEmpty: lane "${laneStatus}" did not drain within ` +
              `${maxWaitMs}ms (${lastCount} task(s) still present) — aborting so ` +
              `the project run-lock is released`,
          ),
        );
      }, maxWaitMs);
      // Don't let this timer alone keep the process alive.
      timer.unref?.();
    }

    // Subscribe FIRST so a change between the initial listTasks and our
    // subscribe doesn't slip past us.
    unsubTasks = deps.subscribeTasks((proj, tasks) => {
      if (proj !== projectPath) return;
      if (evaluate(tasks)) finish();
    });
    // Workflow-run cancellation: resolve the wait so the worker can exit
    // the control step (and release the project run-lock) promptly.
    unsubRun = deps.subscribeRun((ev) => {
      if (!('run' in ev) || ev.run.id !== run.id) return;
      if (ev.type === 'cancelled' || ev.type === 'errored') finish();
    });

    void deps.listTasks(projectPath).then((initial) => {
      if (settled) return;
      if (evaluate(initial)) finish();
    });
  });
}

export function emitControlProgress(
  run: WorkflowRun,
  stepIndex: number,
  kind: WorkflowStepKind,
  current: number,
  total: number,
  message?: string,
): void {
  notify({
    type: 'step-control-progress',
    runId: run.id,
    projectPath: run.projectPath,
    stepIndex,
    kind,
    current,
    total,
    message,
  });
}
