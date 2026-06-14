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

// Resolve when the given lane on `projectPath` is empty (count === 0) OR the
// workflow run is no longer 'running'. Snapshots `total` on first observation
// so progress reporting has a stable denominator.
//
// Subscribes to the task store BEFORE doing the initial read so we don't miss
// a transition that happens between read and subscribe. Also subscribes to
// workflow-run events so cancellation resolves the wait promptly (otherwise
// the lock would be held until something else nudges the task store).
export function waitForLaneEmpty(
  projectPath: string,
  run: WorkflowRun,
  laneStatus: TaskStatus,
  onProgress: (count: number, total: number) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let total = 0;
    let totalCaptured = false;
    let settled = false;
    let unsubTasks: (() => void) | null = null;
    let unsubRun: (() => void) | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      unsubTasks?.();
      unsubRun?.();
      resolve();
    };

    const evaluate = (tasks: Task[]): boolean => {
      const count = tasks.filter((t) => t.status === laneStatus).length;
      if (!totalCaptured) {
        total = Math.max(count, 1);
        totalCaptured = true;
      }
      onProgress(count, total);
      return count === 0 || run.status !== 'running';
    };

    // Subscribe FIRST so a change between the initial listTasks and our
    // subscribe doesn't slip past us.
    unsubTasks = subscribeTasks((proj, tasks) => {
      if (proj !== projectPath) return;
      if (evaluate(tasks)) finish();
    });
    // Workflow-run cancellation: resolve the wait so the worker can exit
    // the control step (and release the project run-lock) promptly.
    unsubRun = subscribe((ev) => {
      if (!('run' in ev) || ev.run.id !== run.id) return;
      if (ev.type === 'cancelled' || ev.type === 'errored') finish();
    });

    void listTasks(projectPath).then((initial) => {
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
