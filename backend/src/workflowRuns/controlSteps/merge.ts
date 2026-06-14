// 'merge' control step — drain In Progress, then drain Ready-to-Merge.
//
// Phase A waits for In Progress to drain; Phase B triggers merge runs until
// Ready-to-Merge is empty. Inner merge runs inherit this step's project
// run-lock (`lockMode: 'inherit'`) so they don't deadlock against the lock the
// control-step worker already holds.

import { listTasks } from '../../tasks.js';
import {
  cancelRun as cancelMergeRun,
  getRun as getMergeRun,
  startMergeRun,
  subscribe as subscribeMergeRuns,
} from '../../mergeRuns.js';
import type { Workflow } from '../../workflows.js';
import { subscribe, type WorkflowRun } from '../state.js';
import { emitControlProgress, waitForLaneEmpty } from './shared.js';

export async function runMergeStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<void> {
  // Cancellation propagation: when the workflow run is cancelled, abort any
  // inner merge run we kicked off. Subscribe once for the whole step.
  let activeMergeRunId: string | null = null;
  const wfUnsub = subscribe((ev) => {
    if (ev.type !== 'cancelled') return;
    if (!('run' in ev) || ev.run.id !== run.id) return;
    if (activeMergeRunId) {
      try {
        cancelMergeRun(activeMergeRunId);
      } catch {
        // best-effort
      }
    }
  });

  try {
    // Phase A: wait for In Progress to drain.
    emitControlProgress(
      run,
      stepIndex,
      'merge',
      0,
      1,
      'waiting for In Progress tasks to finish',
    );
    await waitForLaneEmpty(wf.projectPath, run, 'in_progress', (count, total) => {
      const finished = Math.max(0, total - count);
      emitControlProgress(
        run,
        stepIndex,
        'merge',
        finished,
        total,
        `In Progress draining: ${count} remaining`,
      );
    });
    if (run.status !== 'running') return;

    // Phase B: drain Ready-to-Merge. Loop until the lane is empty — a single
    // merge run may leave conflict-flagged tasks in flight (resolver Claudes),
    // and when they finalize the tasks pop back to ready_to_merge and we
    // re-run. Bail out if a merge run errors so we don't infinite-loop.
    let lastErrorCount = 0;
    while (run.status === 'running') {
      const cur = await listTasks(wf.projectPath);
      const ready = cur.filter((t) => t.status === 'ready_to_merge');
      if (ready.length === 0) break;

      emitControlProgress(
        run,
        stepIndex,
        'merge',
        0,
        ready.length,
        `merging ${ready.length} task(s)`,
      );

      const mergeRun = await startMergeRun(wf.projectPath, backendOrigin, {
        lockMode: 'inherit',
      });
      activeMergeRunId = mergeRun.id;
      await waitForMergeRunFinished(mergeRun.id);
      activeMergeRunId = null;
      if (run.status !== 'running') return;

      const finishedRun = getMergeRun(mergeRun.id);
      if (finishedRun && finishedRun.errored.length > lastErrorCount) {
        // New errors this round. If the lane is unchanged after the run,
        // we'd loop forever — surface the failure.
        lastErrorCount = finishedRun.errored.length;
        const afterTasks = await listTasks(wf.projectPath);
        const stillReady = afterTasks
          .filter((t) => t.status === 'ready_to_merge')
          .map((t) => t.id);
        const sameSet = stillReady.length === ready.length &&
          stillReady.every((id) => ready.some((r) => r.id === id));
        if (sameSet) {
          throw new Error(
            `merge run completed with ${finishedRun.errored.length} error(s) and ready-to-merge lane unchanged; aborting`,
          );
        }
      }
    }

    emitControlProgress(run, stepIndex, 'merge', 1, 1, 'merge complete');
  } finally {
    wfUnsub();
  }
}

function waitForMergeRunFinished(mergeRunId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // Check in case it finished synchronously between startMergeRun returning
    // and our subscribe. Defensive — startMergeRun's worker is fire-and-forget
    // so this should never trigger, but cheap to verify.
    const initial = getMergeRun(mergeRunId);
    if (initial && initial.status !== 'running') {
      resolve();
      return;
    }
    const unsub = subscribeMergeRuns((ev) => {
      if (ev.type !== 'completed' && ev.type !== 'cancelled') return;
      if (ev.run.id !== mergeRunId) return;
      unsub();
      resolve();
    });
  });
}
