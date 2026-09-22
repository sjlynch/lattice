import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workflow, WorkflowQueueEntry, WorkflowRun } from '../../../api';
import {
  initialQueueState,
  step,
  type QueueAction,
  type QueueState,
  type StepContext,
} from '../queueScheduler';
import { sameProjectPath } from '../../../terminal/terminalScope';
import type { StartOutcome, StartRunOptions } from './useWorkflowRunActions';

// Count the active runs the queue itself didn't dispatch (a manual ▶ Run, or a
// run from another tab). Queue-owned runs are the ones whose runId is attached
// to a `started` entry; everything else in `activeRuns` is external and feeds
// the scheduler's sequential gate + enqueue-while-busy auto-start.
function externalActiveContext(
  state: QueueState,
  activeRuns: Record<string, WorkflowRun>,
): StepContext {
  const owned = new Set(
    state.started
      .map((entry) => entry.runId)
      .filter((runId): runId is string => runId !== null),
  );
  let externalActiveCount = 0;
  for (const id of Object.keys(activeRuns)) {
    if (!owned.has(id)) externalActiveCount += 1;
  }
  return { externalActiveCount };
}

type Args = {
  // The active project. Queue state is per-project — switching projects must
  // never show queued/running status from the previous project, nor
  // dispatchFail-drop the prior project's pending entry. WorkflowsLauncher is
  // NOT remounted on a project switch (TopAppBar renders it without a key), so
  // this hook resets its own state when activeFolder changes (mirrors the
  // folder-change reset in useWorkflowRuns).
  activeFolder: string;
  workflowsById: Map<string, Workflow>;
  // Triggers an HTTP /run for the given queued entry. Returns a discriminated
  // outcome: `started` (attach the runId), `busy` (backend 409 — requeue and
  // retry when the slot frees), or `failed` (drop the entry). `opts` carries
  // the sequential `requireNoActiveRun` flag.
  runWorkflow: (
    wf: Workflow,
    entry: WorkflowQueueEntry,
    opts?: StartRunOptions,
  ) => Promise<StartOutcome>;
  // Current set of runs the backend considers active (driven by the
  // /ws/workflow-runs `hello`/`started`/`progress`/`completed` events).
  activeRuns: Record<string, WorkflowRun>;
  // Lingering recently-finished runs (~10s window) — used to look up the
  // final status of a run that just disappeared from activeRuns so we can
  // tell the scheduler whether to cascade into the next workflow (only on
  // success) or stop (on errored/cancelled).
  recentRuns: Record<string, WorkflowRun>;
};

// React adapter for the pure `queueScheduler`. The hook owns the reducer
// state, fires HTTP /run calls for each new start the scheduler returns, and
// translates run-lifecycle WS events into `runFinished` actions by diffing
// `activeRuns` across renders.
//
// All side effects (HTTP, dispatch-of-self) flow through `dispatch`, and
// `dispatch` is stable (empty deps) — so consumers can include it in effect
// dep arrays without re-running the effect on every render.
export function useWorkflowQueue({
  activeFolder,
  workflowsById,
  runWorkflow,
  activeRuns,
  recentRuns,
}: Args): { state: QueueState; dispatch: (action: QueueAction) => void } {
  const [state, setState] = useState<QueueState>(initialQueueState);

  // Mirrored into refs so `dispatch` can stay stable (empty deps) while
  // still reading the freshest values. A stable dispatch keeps the
  // activeRuns-diff effect from re-running on every render.
  const stateRef = useRef(state);
  const activeFolderRef = useRef(activeFolder);
  const activeFolderGenerationRef = useRef(0);
  const workflowsByIdRef = useRef(workflowsById);
  const runWorkflowRef = useRef(runWorkflow);
  const recentRunsRef = useRef(recentRuns);
  const activeRunsRef = useRef(activeRuns);
  stateRef.current = state;
  if (activeFolderRef.current !== activeFolder) {
    activeFolderRef.current = activeFolder;
    activeFolderGenerationRef.current += 1;
  }
  workflowsByIdRef.current = workflowsById;
  runWorkflowRef.current = runWorkflow;
  recentRunsRef.current = recentRuns;
  activeRunsRef.current = activeRuns;

  // Baseline for the activeRuns-diff effect below. Declared here (not at the
  // effect) so the project-reset effect can re-baseline it too.
  const prevActiveRef = useRef(activeRuns);

  const dispatch = useCallback((action: QueueAction) => {
    const ctx = externalActiveContext(stateRef.current, activeRunsRef.current);
    const result = step(stateRef.current, action, ctx);
    // Apply the new state to the ref BEFORE the recursive dispatches below,
    // so a fast-resolving runWorkflow that dispatches workflowStarted
    // synchronously reads the post-action state rather than the pre-action
    // state.
    stateRef.current = result.state;
    setState(result.state);

    // Sequential dispatch demands an empty slot: ask the backend to 409 if a
    // run is already active for the project. This is the authoritative guard
    // that closes the startup-window / multi-tab race the frontend
    // `externalActiveCount` gate can't see. Parallel intentionally allows
    // concurrency, so it omits the flag.
    const requireNoActiveRun = result.state.mode === 'sequential';

    for (const entry of result.starts) {
      const startProject = activeFolderRef.current;
      const startGeneration = activeFolderGenerationRef.current;
      const wf = workflowsByIdRef.current.get(entry.workflowId);
      if (!wf || !startProject || !sameProjectPath(wf.projectPath, startProject)) {
        // Workflow disappeared between enqueue and start (or belonged to a
        // previous project's stale map). Recover in the current queue only.
        dispatch({ type: 'dispatchFailed', entryId: entry.id });
        continue;
      }
      void (async () => {
        const outcome = await runWorkflowRef.current(wf, entry, { requireNoActiveRun });
        if (
          activeFolderRef.current !== startProject ||
          activeFolderGenerationRef.current !== startGeneration
        ) {
          // The request belongs to the project we left. Do not attach its result
          // (or failure) to the newly active project's queue state.
          return;
        }
        if (outcome.status === 'started' && sameProjectPath(outcome.run.projectPath, startProject)) {
          dispatch({ type: 'workflowStarted', entryId: entry.id, runId: outcome.run.id });
        } else if (
          outcome.status === 'finished' &&
          sameProjectPath(outcome.run.projectPath, startProject)
        ) {
          // The completion WS event arrived before /run returned, so this run
          // never appeared in activeRuns and the diff effect cannot emit
          // runFinished for it. Feed the scheduler both halves in order: buffer
          // the finish, then attach/consume the matching run id. This retires
          // the entry and lets a sequential queue advance immediately.
          dispatch({
            type: 'runFinished',
            runId: outcome.run.id,
            status: outcome.run.status,
          });
          dispatch({ type: 'workflowStarted', entryId: entry.id, runId: outcome.run.id });
        } else if (outcome.status === 'busy') {
          // Backend rejected the start (409): a run is already active. Requeue
          // and wait for the active run's runFinished to free the slot.
          dispatch({ type: 'dispatchRejected', entryId: entry.id });
        } else {
          dispatch({ type: 'dispatchFailed', entryId: entry.id });
        }
      })();
    }
  }, []);

  // Reset per-project queue state when the active project changes. The queue
  // (mode/running/queued/started/preFinishedRunIds) belongs to the project it
  // was built in, and WorkflowsLauncher isn't remounted across a project
  // switch — so without this the new project would render the previous
  // project's queued/running status, and the activeRuns-diff below would fire
  // runFinished for the old project's runs (retiring a started entry and
  // making the scheduler try — then dispatchFail-drop — a queued entry that
  // only exists in the old project's workflowsById). Mirrors the
  // folder-change reset in useWorkflowRuns.
  useEffect(() => {
    setState(initialQueueState);
    // Keep the dispatch-visible snapshot in lockstep with the reset so any
    // dispatch before the next render reads the pristine state.
    stateRef.current = initialQueueState;
    // Re-baseline the diff so the new project's `hello` replacing activeRuns
    // doesn't read as "the previous project's runs finished".
    prevActiveRef.current = activeRunsRef.current;
  }, [activeFolder]);

  // Watch `activeRuns` for runs that disappeared since the last render —
  // that's the signal the workflow finished. Dispatch runFinished so the
  // scheduler can pick up the next queued workflow (sequential) or auto-stop
  // (parallel). runFinished against an id we never tracked is a no-op in the
  // reducer, so a manually-started run leaving activeRuns is harmless.
  //
  // Look up the run's final status in `recentRuns` (populated in the same WS
  // event that removed it from `activeRuns`) so the scheduler can decide
  // whether to cascade into the next sequential workflow (only on
  // 'completed') or stop the queue (on 'errored'/'cancelled').
  //
  // The `?? 'errored'` fallback is load-bearing. A real terminal WS event
  // (completed/errored/cancelled) ALWAYS records the run in `recentRuns` before
  // removing it from `activeRuns`, so a run that left `activeRuns` with NO
  // `recentRuns` entry did not finish normally — it vanished from a `hello`
  // full-replace, which only happens when the backend lost the run (a restart
  // or crash wiped the in-memory, non-persisted workflow run). Such a run is
  // interrupted, NOT completed. Defaulting to 'completed' (the old behaviour)
  // made the sequential queue cascade straight into the next workflow while the
  // killed one's tasks were still mid-pipeline — the "the second workflow
  // continues even though the first isn't done, leaving open + unmerged tasks"
  // bug. Treating it as 'errored' stops the queue instead (the reducer cascades
  // only on 'completed'), so the user decides how to proceed; boot recovery
  // separately drains the interrupted run's orphaned ready_to_merge tasks.
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (prev !== activeRuns) {
      for (const id of Object.keys(prev)) {
        if (!activeRuns[id]) {
          const status = recentRunsRef.current[id]?.status ?? 'errored';
          dispatch({ type: 'runFinished', runId: id, status });
        }
      }
      prevActiveRef.current = activeRuns;
    }
  }, [activeRuns, dispatch]);

  return { state, dispatch };
}
