// 'merge' control step — drain In Progress, then drain Ready-to-Merge, then
// wait out the post-merge hook.
//
// Phase A waits for In Progress to drain; Phase B triggers merge runs until
// Ready-to-Merge is empty; Phase C blocks until no post-merge hook is running.
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
import type { Workflow } from '../../workflows.js';
import { runPostMergeHookGate } from '../../postMergeHooks.js';
import { isPostMergeHookOwed } from '../../postMergeHooks/owed.js';
import { subscribe, type WorkflowRun } from '../state.js';
import {
  emitControlProgress,
  waitForLaneEmpty,
  waitForPostMergeHookIdle,
} from './shared.js';

// Backstop for Phase A. An in_progress task whose agent died without committing
// is never auto-completed (the in-progress sweep skips no-commit tasks), so the
// lane never drains on its own. Bound the wait so a stuck agent can't hang the
// worker forever holding the cross-process project run-lock. This is a
// NO-PROGRESS window (see waitForLaneEmpty): it trips only after 30 min with NOT
// A SINGLE task leaving the lane — every drain re-arms it. That distinction is
// load-bearing: the Start step spawns N task agents that then run for tens of
// minutes each, and a *total* 30-min cap raced them — it fired ~5s before the
// last of 29 codex tasks finished, erroring the run so Phase B never merged and
// all 29 completed tasks were stranded at ready_to_merge. As long as tasks keep
// finishing, the wait now continues however long the whole batch takes.
const PHASE_A_DRAIN_TIMEOUT_MS = 30 * 60 * 1000;

// Backstop for Phase C. Same reasoning as Phase A: the hook agent can die
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
  waitForLaneEmpty: typeof waitForLaneEmpty;
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
  waitForLaneEmpty,
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
    let settled = false;
    let unsub: (() => void) | null = null;
    let unsubscribeAfterAssign = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (unsub) unsub();
      else unsubscribeAfterAssign = true;
      resolve();
    };
    // Subscribe BEFORE the status check so a cancel in between isn't missed.
    unsub = subscribeWorkflowRuns((ev) => {
      if (!('run' in ev) || ev.run.id !== run.id) return;
      if (ev.type === 'cancelled' || ev.type === 'errored') finish();
    });
    if (unsubscribeAfterAssign) unsub();
    if (run.status !== 'running') finish();
    work.then(finish, (err: unknown) => {
      console.warn('[workflow-run] owed post-merge hook failed:', err);
      finish();
    });
  });
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
  let activeMergeRunId: string | null = null;
  const wfUnsub = deps.subscribeWorkflowRuns((ev) => {
    if (ev.type !== 'cancelled') return;
    if (!('run' in ev) || ev.run.id !== run.id) return;
    if (activeMergeRunId) {
      try {
        deps.cancelMergeRun(activeMergeRunId);
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
    await deps.waitForLaneEmpty(
      wf.projectPath,
      run,
      'in_progress',
      (count, total) => {
        const finished = Math.max(0, total - count);
        emitControlProgress(
          run,
          stepIndex,
          'merge',
          finished,
          total,
          `In Progress draining: ${count} remaining`,
        );
      },
      PHASE_A_DRAIN_TIMEOUT_MS,
    );
    if (run.status !== 'running') return;

    // Phase B: drain Ready-to-Merge. Loop until the lane is empty — a single
    // merge run resolves conflicts in-process (it blocks on each resolver Stop
    // hook), so by the time it finishes, every task it touched has either left
    // the lane (merged → qa) or been re-queued at ready_to_merge. We re-run to
    // pick up the re-queued / conflict-flagged ones.
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
    while (run.status === 'running') {
      const cur = await deps.listTasks(wf.projectPath);
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
      activeMergeRunId = mergeRun.id;
      // Cancellation may arrive while startup awaits lock/task I/O, before
      // the subscription above has an ID to cancel. Still await the worker's
      // completion after cancelling: it uses this step's project lock and may
      // be restoring a snapshot before it is safe to release that lock.
      if (run.status !== 'running') deps.cancelMergeRun(mergeRun.id);
      await waitForMergeRunFinished(mergeRun.id, deps);
      activeMergeRunId = null;
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
        const finishedRun = deps.getMergeRun(mergeRun.id);
        const errorCount = finishedRun?.errored.length ?? 0;
        // A run that halted itself (full disk, a held git lock, an integrity
        // violation) records why under '(run)' — that is the reason to show.
        const halted = finishedRun?.errored.find((e) => e.taskId === '(run)');
        throw new Error(
          `merge step made no progress: ${readyIdsBefore.length} task(s) ` +
            `still ready-to-merge after a full merge run (${errorCount} ` +
            `errored); aborting to avoid an infinite loop` +
            (halted ? ` — the merge run ${halted.error}` : ''),
        );
      }
    }

    // Phase C: wait out the post-merge hook.
    //
    // A hook fired BY a merge run is already covered — mergeRuns.ts awaits
    // runPostMergeHook before finishRun, so Phase B's waitForMergeRunFinished
    // transitively waited for it and this resolves immediately. What this
    // catches is a hook fired OUTSIDE a run by `awaitPostMergeHookOutsideRun`
    // (routes/tasks/hooks/: the resolver `/complete` branch, `/merged`,
    // `/stash-resolved`) — those fire precisely when no merge run is active, so
    // nothing else gates them. Completing the step with one of those in flight
    // lets the workflow run finish, and the frontend queue's only sequential
    // gate (`assertNoActiveWorkflowRun`) counts workflow runs, not hooks — so it
    // would start the next queued workflow's step 1 on top of a still-running
    // post-merge agent, exactly the overlap this phase exists to prevent.
    //
    // First, though: a merge that landed before a backend restart may still
    // OWE its hook — the restarted Phase B found Ready-to-Merge empty and ran
    // no merge run, so nothing fired it. Fire it here (and wait it out).
    //
    // Raced against the workflow run ending: a cancel during this wait must
    // free the worker (and its run.lock) now, not when the hook finishes.
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

    emitControlProgress(run, stepIndex, 'merge', 1, 1, 'merge complete');
  } finally {
    wfUnsub();
  }
}

export function waitForMergeRunFinished(
  mergeRunId: string,
  deps: Pick<MergeStepDeps, 'getMergeRun' | 'subscribeMergeRuns'>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    let unsubscribeAfterAssign = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (unsub) unsub();
      else unsubscribeAfterAssign = true;
      resolve();
    };

    // Subscribe BEFORE checking the current snapshot. The old check-then-
    // subscribe flow could miss a fast worker that completed in the gap after
    // getMergeRun(id) returned `running` but before subscribeMergeRuns() was
    // installed, leaving workflow Merge control steps parked forever.
    unsub = deps.subscribeMergeRuns((ev) => {
      if (ev.type !== 'completed' && ev.type !== 'cancelled') return;
      if (ev.run.id !== mergeRunId) return;
      finish();
    });
    if (unsubscribeAfterAssign) unsub();

    const current = deps.getMergeRun(mergeRunId);
    if (current && current.status !== 'running') finish();
  });
}
