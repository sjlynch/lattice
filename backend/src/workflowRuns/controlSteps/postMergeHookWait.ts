// `waitForPostMergeHookIdle` — the merge step's Phase C post-merge-hook gate
// (re-exported from shared.ts).

import {
  getActiveHookForProject,
  hasPendingPostMergeHookTrigger,
  subscribePostMergeHooks,
  subscribePostMergeHookTriggers,
  type PostMergeHookRun,
} from '../../postMergeHooks.js';
import { subscribe, type WorkflowRun } from '../state.js';
import { createUnrefTimer, createWaitSettler, isRunEndedEvent } from './waitPrimitives.js';

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
    let reportedId: string | null = null;
    let lastActiveId: string | null = null;
    let unsubHooks: (() => void) | null = null;
    let unsubTriggers: (() => void) | null = null;
    let unsubRun: (() => void) | null = null;
    let idleCheck: ReturnType<typeof setImmediate> | null = null;

    // A single bound for the whole gate (armed once, never re-armed).
    const timer = maxWaitMs !== undefined && maxWaitMs > 0
      ? createUnrefTimer(maxWaitMs, () => {
        fail(
          new Error(
            `waitForPostMergeHookIdle: post-merge hook ${lastActiveId ?? '(unknown)'} ` +
              `did not finish within ${maxWaitMs}ms — aborting so the project ` +
              `run-lock is released`,
          ),
        );
      })
      : null;

    const { finish, fail, settled } = createWaitSettler<void>({
      resolve,
      reject,
      cleanup: () => {
        unsubHooks?.();
        unsubTriggers?.();
        unsubRun?.();
        timer?.clear();
        if (idleCheck) clearImmediate(idleCheck);
      },
    });

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
      if (idleCheck || settled()) return;
      idleCheck = setImmediate(() => {
        idleCheck = null;
        if (evaluate()) finish();
      });
    };

    timer?.arm();

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
