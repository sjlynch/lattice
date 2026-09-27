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
import { fetchWorkflowRun } from '../../../api';
import type { StartOutcome } from './useWorkflowRunActions';
import { resolveVanishedRun, type VanishedRunDeps } from './vanishedRunResolver';
import { classifyVanishedRuns, queueActionsForStartOutcome } from './startOutcomeActions';

// Count the active runs the queue itself didn't dispatch (a manual ▶ Run, or a
// run from another tab). Queue-owned runs are the ones whose runId is attached
// to a `started` entry; everything else in `activeRuns` is external and feeds
// the scheduler's one-at-a-time gate + enqueue-while-busy auto-start.
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
  // retry when the slot frees), or `failed` (drop the entry).
  runWorkflow: (wf: Workflow, entry: WorkflowQueueEntry) => Promise<StartOutcome>;
  // Current set of runs the backend considers active (driven by the
  // /ws/workflow-runs `hello`/`started`/`progress`/`completed` events).
  activeRuns: Record<string, WorkflowRun>;
  // Lingering recently-finished runs (~10s window) — used to look up the
  // final status of a run that just disappeared from activeRuns so we can
  // tell the scheduler whether to cascade into the next workflow (only on
  // success) or stop (on errored/cancelled).
  recentRuns: Record<string, WorkflowRun>;
  // GET one run by id (`null` = 404). Injectable for tests; defaults to
  // `fetchWorkflowRun`. See the vanished-run note on the diff effect below.
  fetchRun?: (projectPath: string, runId: string) => Promise<WorkflowRun | null>;
  // Test seam for the resolver's timers.
  vanishedRunTiming?: Pick<VanishedRunDeps, 'sleep' | 'now'>;
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
  fetchRun = fetchWorkflowRun,
  vanishedRunTiming,
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
  const fetchRunRef = useRef(fetchRun);
  const vanishedRunTimingRef = useRef(vanishedRunTiming);
  // Run ids whose vanish is being resolved (see the diff effect), so a second
  // re-render never starts a second resolution for the same run.
  const resolvingVanishedRef = useRef(new Set<string>());
  const unmountedRef = useRef(false);
  stateRef.current = state;
  fetchRunRef.current = fetchRun;
  vanishedRunTimingRef.current = vanishedRunTiming;
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

    // The backend 409s a start while a run is already active for the project.
    // That is the authoritative guard that closes the startup-window /
    // multi-tab race the frontend `externalActiveCount` gate can't see; the
    // `busy` outcome below requeues the entry.
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
        const outcome = await runWorkflowRef.current(wf, entry);
        if (
          activeFolderRef.current !== startProject ||
          activeFolderGenerationRef.current !== startGeneration
        ) {
          // The request belongs to the project we left. Do not attach its result
          // (or failure) to the newly active project's queue state.
          return;
        }
        for (const next of queueActionsForStartOutcome(outcome, entry.id, startProject)) {
          dispatch(next);
        }
      })();
    }
  }, []);

  // Reset per-project queue state when the active project changes. The queue
  // (running/queued/started/preFinishedRunIds) belongs to the project it
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
    // In-flight vanished-run resolutions belong to the previous project; they
    // see the generation change and stop on their own.
    resolvingVanishedRef.current = new Set();
  }, [activeFolder]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Watch `activeRuns` for runs that disappeared since the last render —
  // that's the signal the workflow finished. Dispatch runFinished so the
  // scheduler can pick up the next queued workflow or auto-stop once the queue
  // is drained. runFinished against an id we never tracked is a no-op in the
  // reducer, so a manually-started run leaving activeRuns is harmless.
  //
  // Look up the run's final status in `recentRuns` (populated in the same WS
  // event that removed it from `activeRuns`) so the scheduler can decide
  // whether to cascade into the next queued workflow (only on
  // 'completed') or stop the queue (on 'errored'/'cancelled').
  //
  // A run that left `activeRuns` with NO `recentRuns` entry never got a
  // terminal WS event (one always records the run in `recentRuns` before
  // removing it) — it vanished from a `hello` full-replace. It must NOT be
  // read as 'completed': cascading the next workflow onto an interrupted run's
  // still-pending tasks was the "second workflow continues, leaving open +
  // unmerged tasks" bug. But reading it as 'errored' on the spot stopped the
  // queue on every backend restart too, since a tab reconnecting mid-recovery
  // can see a hello without the (persisted, about-to-be-restored) run, or the
  // run may simply have finished while the socket was down. So for a run THIS
  // queue owns, `resolveVanishedRun` waits a short grace and then asks the
  // backend for the run by id: back in `activeRuns` → nothing happened;
  // recorded final status → report it; unknown (404) → 'errored', which stops
  // the queue (the reducer cascades only on 'completed') so the user decides.
  // Runs the queue doesn't own are reported immediately — runFinished for an
  // untracked id is a no-op in the reducer.
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (prev !== activeRuns) {
      // Classified before dispatching: runFinished only retires its own run's
      // entry, so reporting one run can't change whether the queue owns another.
      const { report, resolve } = classifyVanishedRuns(
        prev,
        activeRuns,
        recentRunsRef.current,
        stateRef.current.started,
      );
      for (const { runId, status } of report) {
        dispatch({ type: 'runFinished', runId, status });
      }
      for (const id of resolve) {
        const resolving = resolvingVanishedRef.current;
        if (resolving.has(id)) continue;
        resolving.add(id);
        const project = activeFolderRef.current;
        const generation = activeFolderGenerationRef.current;
        const cancelled = () =>
          unmountedRef.current ||
          activeFolderRef.current !== project ||
          activeFolderGenerationRef.current !== generation;
        void resolveVanishedRun({
          isActive: () => !!activeRunsRef.current[id],
          recentStatus: () => recentRunsRef.current[id]?.status,
          fetchRun: () => fetchRunRef.current(project, id),
          isCancelled: cancelled,
          ...vanishedRunTimingRef.current,
        }).then((status) => {
          resolving.delete(id);
          if (status && !cancelled()) dispatch({ type: 'runFinished', runId: id, status });
        });
      }
      prevActiveRef.current = activeRuns;
    }
  }, [activeRuns, dispatch]);

  return { state, dispatch };
}
