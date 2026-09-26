// 'merge' control step — drain admitted task runs and their Ready-to-Merge
// work, then wait out the post-merge hook and re-check the combined drain.
//
// Merge ready work while queued/running tasks settle, including when freeing
// those worktrees is what lets disk-held starts proceed.
// Inner merge runs inherit this step's project run-lock (`lockMode: 'inherit'`)
// so they don't deadlock against the lock the control-step worker already
// holds.

import { listTasks } from '../../tasks.js';
import {
  cancelRun as cancelMergeRun,
  getRun as getMergeRun,
  startMergeRun,
  subscribe as subscribeMergeRuns,
} from '../../mergeRuns.js';
import type { MergeRun } from '../../mergeRuns/state.js';
import type { Workflow } from '../../workflows.js';
import { runPostMergeHookGate } from '../../postMergeHooks.js';
import { isPostMergeHookOwed } from '../../postMergeHooks/owed.js';
import { subscribe, type WorkflowRun } from '../state.js';
import {
  emitControlProgress,
  isRunEndedEvent,
  subscribeOnce,
  waitForMergeWork,
  waitForPostMergeHookIdle,
} from './shared.js';

// A no-progress window, not a total batch deadline. Queued starts can stall on
// capacity/disk and an agent can die without committing. Either must eventually
// error the worker and release its project lock, while forward task transitions
// keep a productive batch alive however long it takes overall.
const TASK_DRAIN_TIMEOUT_MS = 30 * 60 * 1000;

// Backstop for Phase C. Same reasoning as the task drain: the hook agent can die
// without ever calling /complete, and an unbounded wait would hang the worker
// and leak the project run-lock. The hook prompt is a full agent task, so give
// it the same 30 min.
const PHASE_C_HOOK_TIMEOUT_MS = 30 * 60 * 1000;

// Injectable seam (production default below). The Phase B drain loop is the
// trickiest part of this step to get right (it's what infinite-looped on
// persistently-erroring tasks), so the regression test overrides these to
// simulate a clean-merging task plus two that error every round — without
// spawning a real merge run / git — and asserts the step aborts instead of
// spinning forever.
export type MergeStepDeps = {
  listTasks: typeof listTasks;
  startMergeRun: typeof startMergeRun;
  getMergeRun: typeof getMergeRun;
  cancelMergeRun: typeof cancelMergeRun;
  subscribeMergeRuns: typeof subscribeMergeRuns;
  subscribeWorkflowRuns: typeof subscribe;
  waitForMergeWork: typeof waitForMergeWork;
  waitForPostMergeHookIdle: typeof waitForPostMergeHookIdle;
  // Fire a post-merge hook a pre-restart merge still owes (postMergeHooks/
  // owed.ts) and wait it out. Optional so test doubles can omit it.
  // `shouldStop` turns true once the workflow run leaves 'running'; the step
  // stops waiting at that point regardless (see raceWorkflowRunEnd), and the
  // gate uses it not to fire anything further for a cancelled run.
  fireOwedPostMergeHook?: (
    projectPath: string,
    backendOrigin: string,
    shouldStop: () => boolean,
  ) => Promise<void>;
};

const productionDeps: MergeStepDeps = {
  listTasks,
  startMergeRun,
  getMergeRun,
  cancelMergeRun,
  subscribeMergeRuns,
  subscribeWorkflowRuns: subscribe,
  waitForMergeWork,
  waitForPostMergeHookIdle,
  fireOwedPostMergeHook,
};

async function fireOwedPostMergeHook(
  projectPath: string,
  backendOrigin: string,
  shouldStop: () => boolean,
): Promise<void> {
  if (!(await isPostMergeHookOwed(projectPath))) return;
  if (shouldStop()) return;
  console.log(`[workflow-run] post-merge hook owed by a merge before the restart — firing it for ${projectPath}`);
  await runPostMergeHookGate(
    { projectPath, backendOrigin, trigger: 'merge-run' },
    undefined,
    shouldStop,
  ).catch((err) => console.warn('[workflow-run] owed post-merge hook failed:', err));
}

// Resolve when `work` settles OR the workflow run leaves 'running' (a
// cancelled / errored event for it), whichever comes first. The owed-hook gate
// has no cancel signal of its own — it waits on the hook agent for up to
// 30 min, 3 rounds on repeated `already-running` — and the Merge step's worker
// holds the `workflow-merge:*` run.lock the whole time: a cancel during Phase C
// kept Merge All 409ing and the dev runner deferring restarts until the hook
// finished. Same reason `waitForPostMergeHookIdle` resolves on cancel. The
// gate itself keeps waiting on its hook in the background (the hook agent is
// not killed — a cancel never killed one in Phase C's idle wait either); its
// `shouldStop` keeps it from firing another.
export function raceWorkflowRunEnd(
  run: WorkflowRun,
  subscribeWorkflowRuns: typeof subscribe,
  work: Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    // Subscribe BEFORE the status check so a cancel in between isn't missed.
    const finish = subscribeOnce(
      (settle) => subscribeWorkflowRuns((ev) => {
        if (isRunEndedEvent(ev, run.id)) settle();
      }),
      resolve,
    );
    if (run.status !== 'running') finish();
    work.then(finish, (err: unknown) => {
      console.warn('[workflow-run] owed post-merge hook failed:', err);
      finish();
    });
  });
}

// The inner merge run Phase B has in flight, shared with runMergeStep's cancel
// subscriber so a workflow cancel can abort it.
type ActiveMergeRun = { id: string | null };

async function waitForTaskWork(wf: Workflow, run: WorkflowRun, stepIndex: number, deps: MergeStepDeps) {
  let hadPending = false;
  const tasks = await deps.waitForMergeWork(wf.projectPath, run, (count, total) => {
    if (count > 0) hadPending = true;
    emitControlProgress(run, stepIndex, 'merge', Math.max(0, total - count), total,
      `waiting for queued/In Progress tasks: ${count} remaining`);
  }, TASK_DRAIN_TIMEOUT_MS);
  return { tasks, hadPending };
}

// Drain queued/In Progress and Ready-to-Merge together. A single
// merge run resolves conflicts in-process (it blocks on each resolver Stop
// hook), so by the time it finishes, every task it touched has either left
// the lane (merged → qa) or been re-queued at ready_to_merge. We re-run to
// pick up the re-queued / conflict-flagged ones. Returns as soon as the
// workflow run leaves 'running'.
//
// Termination guard: bail out the moment a round makes NO forward progress,
// i.e. not a single task left the ready_to_merge lane. Persistently-
// erroring tasks (a card dragged in with no branch/worktree, a held merge
// lock, an uncaught per-task error) get pushed to the run's `errored` list
// but are LEFT at ready_to_merge by processTarget, so they reappear every
// round. The previous guard only tripped when the per-round error COUNT
// strictly increased (`errored.length > lastErrorCount`), but each
// startMergeRun builds a fresh MergeRun with `errored: []`, so a steady
// error count (round 2+ with the same stuck tasks) slipped past it and the
// step looped forever — holding the per-project run-lock and burning CPU.
// Comparing the lane id-set before/after each run catches it regardless of
// the error count.
async function drainReadyToMerge(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  deps: MergeStepDeps,
  activeMergeRun: ActiveMergeRun,
): Promise<void> {
  while (run.status === 'running') {
    const { tasks: cur } = await waitForTaskWork(wf, run, stepIndex, deps);
    if (run.status !== 'running') return;
    const ready = cur.filter((t) => t.status === 'ready_to_merge');
    if (ready.length === 0) break;
    const readyIdsBefore = ready.map((t) => t.id);

    emitControlProgress(
      run,
      stepIndex,
      'merge',
      0,
      ready.length,
      `merging ${ready.length} task(s)`,
    );

    const mergeRun = await deps.startMergeRun(wf.projectPath, backendOrigin, {
      lockMode: 'inherit',
    });
    activeMergeRun.id = mergeRun.id;
    // Cancellation may arrive while startup awaits lock/task I/O, before
    // the cancel subscription has an ID to cancel. Still await the worker's
    // completion after cancelling: it uses this step's project lock and may
    // be restoring a snapshot before it is safe to release that lock.
    if (run.status !== 'running') deps.cancelMergeRun(mergeRun.id);
    await waitForMergeRunFinished(mergeRun.id, deps);
    activeMergeRun.id = null;
    if (run.status !== 'running') return;

    const afterTasks = await deps.listTasks(wf.projectPath);
    const stillReady = new Set(
      afterTasks
        .filter((t) => t.status === 'ready_to_merge')
        .map((t) => t.id),
    );
    // Forward progress = at least one task that was ready before the run is
    // no longer ready (merged → qa, deleted, or pulled to another lane). If
    // every pre-run task is STILL ready, the run accomplished nothing and
    // re-running would loop forever — abort so the run errors out (and the
    // project lock is released) instead of spinning.
    const someLeftLane = readyIdsBefore.some((id) => !stillReady.has(id));
    if (!someLeftLane) {
      throw noProgressError(readyIdsBefore, deps.getMergeRun(mergeRun.id));
    }
  }
}

// The error Phase B aborts with when a full merge run moved nothing out of
// Ready-to-Merge.
function noProgressError(
  readyIdsBefore: string[],
  finishedRun: MergeRun | null,
): Error {
  const errorCount = finishedRun?.errored.length ?? 0;
  // A run that halted itself (full disk, a held git lock, an integrity
  // violation) records why under '(run)' — that is the reason to show.
  const halted = finishedRun?.errored.find((e) => e.taskId === '(run)');
  // Otherwise name the first per-task error — "1 errored" alone left
  // the user no way to tell a dead resolver from a git failure.
  const taskError = halted ? undefined : finishedRun?.errored[0];
  return new Error(
    `merge step made no progress: ${readyIdsBefore.length} task(s) ` +
      `still ready-to-merge after a full merge run (${errorCount} ` +
      `errored); aborting to avoid an infinite loop` +
      (halted ? ` — the merge run ${halted.error}` : '') +
      (taskError ? ` — task ${taskError.taskId}: ${taskError.error}` : ''),
  );
}

export async function runMergeStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  deps: MergeStepDeps = productionDeps,
): Promise<void> {
  // Cancellation propagation: when the workflow run is cancelled, abort any
  // inner merge run we kicked off. Subscribe once for the whole step.
  const activeMergeRun: ActiveMergeRun = { id: null };
  const wfUnsub = deps.subscribeWorkflowRuns((ev) => {
    if (ev.type !== 'cancelled') return;
    if (!('run' in ev) || ev.run.id !== run.id) return;
    if (activeMergeRun.id) {
      try {
        deps.cancelMergeRun(activeMergeRun.id);
      } catch {
        // best-effort
      }
    }
  });

  try {
    while (run.status === 'running') {
      // Re-evaluate queued/in-flight/running work after EVERY merge round. Ready
      // work must be merged even while another task is waiting for disk space.
      await drainReadyToMerge(wf, run, stepIndex, backendOrigin, deps, activeMergeRun);

      // Phase C: wait out the post-merge hook. A hook fired BY a merge run is
      // covered by waitForMergeRunFinished. This also gates hooks fired OUTSIDE
      // a run (resolver callbacks) and hooks still owed after a backend restart.
      // The frontend workflow queue observes workflow runs, not hook agents, so
      // completing here with a live hook would let the next workflow overlap it.
      // Race the owed-hook wait against cancellation so run.lock is released
      // promptly even if that hook never calls back.
      if (run.status !== 'running') return;
      if (deps.fireOwedPostMergeHook) {
        const isStopped = () => run.status !== 'running';
        await raceWorkflowRunEnd(
          run,
          deps.subscribeWorkflowRuns,
          deps.fireOwedPostMergeHook(wf.projectPath, backendOrigin, isStopped),
        );
      }
      if (run.status !== 'running') return;
      await deps.waitForPostMergeHookIdle(
        wf.projectPath,
        run,
        (hook) => {
          emitControlProgress(
            run,
            stepIndex,
            'merge',
            0,
            1,
            `waiting for the post-merge hook (${hook.harness}) to finish`,
          );
        },
        PHASE_C_HOOK_TIMEOUT_MS,
      );
      if (run.status !== 'running') return;

      // A task may have been admitted or finished while the hook gate was active.
      // Drain its work too, then pass the hook gate after the actual final merge.
      const { tasks: remaining, hadPending } = await waitForTaskWork(wf, run, stepIndex, deps);
      if (run.status !== 'running') return;
      // Pending work can settle via an outside resolver too. Re-run the hook
      // gate even when that work already reached QA during this last wait.
      if (hadPending || remaining.some((task) => task.status === 'ready_to_merge')) continue;
      emitControlProgress(run, stepIndex, 'merge', 1, 1, 'merge complete');
      return;
    }
  } finally {
    wfUnsub();
  }
}

export function waitForMergeRunFinished(
  mergeRunId: string,
  deps: Pick<MergeStepDeps, 'getMergeRun' | 'subscribeMergeRuns'>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    // Subscribe BEFORE checking the current snapshot. The old check-then-
    // subscribe flow could miss a fast worker that completed in the gap after
    // getMergeRun(id) returned `running` but before subscribeMergeRuns() was
    // installed, leaving workflow Merge control steps parked forever.
    const finish = subscribeOnce(
      (settle) => deps.subscribeMergeRuns((ev) => {
        if (ev.type !== 'completed' && ev.type !== 'cancelled') return;
        if (ev.run.id !== mergeRunId) return;
        settle();
      }),
      resolve,
    );

    const current = deps.getMergeRun(mergeRunId);
    if (current && current.status !== 'running') finish();
  });
}
