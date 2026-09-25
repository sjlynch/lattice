// Shared helpers for the control-step workers (start / merge / push).
//
// `waitForLaneEmpty` is the lane-drain subscription used by both the merge
// and push steps; `waitForPostMergeHookIdle` is the merge step's post-merge
// hook gate; `emitControlProgress` is the single place that shapes the
// `step-control-progress` WS payload so every worker reports progress the
// same way. `subscribeOnce` / `isRunEndedEvent` are the small subscription
// primitives the waits share.

import { listTasks, subscribe as subscribeTasks } from '../../tasks.js';
import type { Task, TaskStatus } from '../../tasks.js';
import {
  getActiveHookForProject,
  hasPendingPostMergeHookTrigger,
  subscribePostMergeHooks,
  subscribePostMergeHookTriggers,
  type PostMergeHookRun,
} from '../../postMergeHooks.js';
import type { WorkflowStepKind } from '../../workflows.js';
import {
  notify,
  subscribe,
  type WorkflowRun,
  type WorkflowRunEvent,
} from '../state.js';

// True for the event that ends workflow run `runId` early — it was cancelled
// or errored. Every control-step wait resolves on it so the worker can exit
// (and release the project run-lock) promptly.
export function isRunEndedEvent(ev: WorkflowRunEvent, runId: string): boolean {
  if (!('run' in ev) || ev.run.id !== runId) return false;
  return ev.type === 'cancelled' || ev.type === 'errored';
}

// Subscribe-before-check wait that settles exactly once. `install` subscribes
// a listener that calls `settle` and returns its unsubscribe; the returned
// function is that same `settle`, for the caller's own checks. Settling
// unsubscribes, then calls `onSettle` — even when the listener fires
// synchronously inside `install`, before its unsubscribe exists (it is then
// called right after assignment).
export function subscribeOnce(
  install: (settle: () => void) => () => void,
  onSettle: () => void,
): () => void {
  let settled = false;
  let unsub: (() => void) | null = null;
  let unsubscribeAfterAssign = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (unsub) unsub();
    else unsubscribeAfterAssign = true;
    onSettle();
  };
  unsub = install(settle);
  if (unsubscribeAfterAssign) unsub();
  return settle;
}

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
    let settled = false;
    let lastCount = 0;
    // Lowest lane count seen so far. The timeout below is re-armed every time
    // the count drops BELOW this floor — i.e. every time a task actually leaves
    // the lane — so it measures "time since the lane last made progress", not
    // total elapsed time. A steadily-draining lane never trips it; only a lane
    // that stalls (a dead agent that never commits) does.
    let progressFloor = Number.POSITIVE_INFINITY;
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
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    // (Re)arm the no-progress backstop. Called on the first observation and then
    // again every time a task leaves the lane, so a lane that keeps draining —
    // however slowly, and however long it takes in total — never trips it.
    const armTimer = (): void => {
      if (maxWaitMs === undefined || maxWaitMs <= 0) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        fail(
          new Error(
            `waitForLaneEmpty: lane "${laneStatus}" made no progress for ` +
              `${maxWaitMs}ms (${lastCount} task(s) still present) — aborting so ` +
              `the project run-lock is released`,
          ),
        );
      }, maxWaitMs);
      // Don't let this timer alone keep the process alive.
      timer.unref?.();
    };

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
        armTimer();
      }
      onProgress(count, total);
      return count === 0 || run.status !== 'running';
    };

    // Subscribe FIRST so a change between the initial listTasks and our
    // subscribe doesn't slip past us.
    unsubTasks = deps.subscribeTasks((proj, tasks) => {
      if (settled || proj !== projectPath) return;
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
    armTimer();
    try {
      void deps.listTasks(projectPath).then((initial) => {
        if (settled) return;
        if (evaluate(initial)) finish();
      }).catch(fail);
    } catch (err) {
      fail(err);
    }
  });
}

// The post-merge-hook registry subscriptions `waitForPostMergeHookIdle` leans
// on, injectable so the gate can be unit-tested without a real hook session.
export type PostMergeHookWaitDeps = {
  getActiveHookForProject: typeof getActiveHookForProject;
  subscribePostMergeHooks: typeof subscribePostMergeHooks;
  subscribeRun: typeof subscribe;
  hasPendingPostMergeHookTrigger?: typeof hasPendingPostMergeHookTrigger;
  subscribePostMergeHookTriggers?: typeof subscribePostMergeHookTriggers;
};

const productionPostMergeHookWaitDeps: PostMergeHookWaitDeps = {
  getActiveHookForProject,
  subscribePostMergeHooks,
  subscribeRun: subscribe,
  hasPendingPostMergeHookTrigger,
  subscribePostMergeHookTriggers,
};

// Resolve once NO post-merge hook is running for `projectPath` (or the
// workflow run is no longer 'running' — cancellation).
//
// Why the merge step needs this even though a merge run already gates itself:
// `mergeRuns.ts` awaits `runPostMergeHook` before `finishRun`, so a hook fired
// *by a run* is covered — the step's `waitForMergeRunFinished` transitively
// waits for it. But a hook can also fire from `awaitPostMergeHookOutsideRun`
// (`routes/tasks/hooks/` — the resolver `/complete` branch, `/merged`, and
// `/stash-resolved`), which by definition runs when NO merge run is active, so
// no run's `finishRun` gates it. Without this the step would report "merge
// complete", the workflow run would finish, and the frontend queue — whose only
// sequential gate is `assertNoActiveWorkflowRun`, which counts workflow runs and
// not hooks — would dispatch the NEXT workflow's step 1 alongside the still-
// running hook. Gating here (rather than in the queue) keeps the wait bounded
// and keeps the queue from stalling on a signal it can't observe.
//
// Same shape as waitForLaneEmpty: subscribe BEFORE the initial read so a
// `finished` event in the gap isn't missed, and honour the same BOUNDED-WAIT
// invariant — a hook agent that dies without calling back must not hang the
// worker and leak the cross-process project run-lock, so expiry REJECTS.
export function waitForPostMergeHookIdle(
  projectPath: string,
  run: WorkflowRun,
  onActive: (hook: PostMergeHookRun) => void,
  maxWaitMs?: number,
  deps: PostMergeHookWaitDeps = productionPostMergeHookWaitDeps,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let reportedId: string | null = null;
    let lastActiveId: string | null = null;
    let unsubHooks: (() => void) | null = null;
    let unsubTriggers: (() => void) | null = null;
    let unsubRun: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let idleCheck: ReturnType<typeof setImmediate> | null = null;

    const cleanup = () => {
      unsubHooks?.();
      unsubTriggers?.();
      unsubRun?.();
      if (timer) clearTimeout(timer);
      if (idleCheck) clearImmediate(idleCheck);
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

    // True once the gate is open. Reports each hook we wait on exactly once —
    // keyed by id, so a chatty `progress` stream can't spam the run strip with
    // duplicate lines, but a *second* hook starting while we're still parked
    // (one finishes, another fires) still gets its own line.
    const evaluate = (): boolean => {
      if (run.status !== 'running') return true;
      const active = deps.getActiveHookForProject(projectPath);
      if (!active) {
        return !(deps.hasPendingPostMergeHookTrigger?.(projectPath) ?? false);
      }
      lastActiveId = active.id;
      if (reportedId !== active.id) {
        reportedId = active.id;
        onActive(active);
      }
      return false;
    };

    // Do not resolve on the same turn as the first idle observation. A task
    // finalizer publishes its QA transition before its continuation invokes
    // the post-merge hook; that task event can wake the Merge step and reach
    // Phase C in the narrow gap between those operations. Keeping the
    // subscription alive through one event-loop turn lets the hook's
    // synchronous `recordPostMergeHook` event close the gate before it opens.
    const reevaluate = (): void => {
      if (!evaluate()) {
        if (idleCheck) {
          clearImmediate(idleCheck);
          idleCheck = null;
        }
        return;
      }
      if (idleCheck || settled) return;
      idleCheck = setImmediate(() => {
        idleCheck = null;
        if (evaluate()) finish();
      });
    };

    if (maxWaitMs !== undefined && maxWaitMs > 0) {
      timer = setTimeout(() => {
        fail(
          new Error(
            `waitForPostMergeHookIdle: post-merge hook ${lastActiveId ?? '(unknown)'} ` +
              `did not finish within ${maxWaitMs}ms — aborting so the project ` +
              `run-lock is released`,
          ),
        );
      }, maxWaitMs);
      timer.unref?.();
    }

    // Subscribe FIRST so a hook finishing between our subscribe and the
    // initial evaluate() can't slip past. Deliberately NOT filtered by
    // project: `getActiveHookForProject` canonicalizes the path it compares,
    // while `ev.run.projectPath` is whatever string the trigger was handed, so
    // a raw !== filter here would drop events for our own project. Re-evaluate
    // on every hook event and let the canonicalizing lookup decide — hook
    // events are rare, so the extra map scans are free.
    unsubHooks = deps.subscribePostMergeHooks(() => {
      reevaluate();
    });
    unsubTriggers = deps.subscribePostMergeHookTriggers?.(() => {
      reevaluate();
    }) ?? null;
    unsubRun = deps.subscribeRun((ev) => {
      if (isRunEndedEvent(ev, run.id)) finish();
    });

    reevaluate();
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
