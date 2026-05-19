import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workflow, WorkflowQueueEntry, WorkflowRun } from '../../../api';
import {
  initialQueueState,
  step,
  type QueueAction,
  type QueueState,
} from '../queueScheduler';

type Args = {
  workflowsById: Map<string, Workflow>;
  // Triggers an HTTP /run for the given queued entry. Returns the run record
  // on success and null on failure (e.g. backend rejected, network error).
  runWorkflow: (
    wf: Workflow,
    entry: WorkflowQueueEntry,
  ) => Promise<WorkflowRun | null>;
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
  const workflowsByIdRef = useRef(workflowsById);
  const runWorkflowRef = useRef(runWorkflow);
  const recentRunsRef = useRef(recentRuns);
  stateRef.current = state;
  workflowsByIdRef.current = workflowsById;
  runWorkflowRef.current = runWorkflow;
  recentRunsRef.current = recentRuns;

  const dispatch = useCallback((action: QueueAction) => {
    const result = step(stateRef.current, action);
    // Apply the new state to the ref BEFORE the recursive dispatches below,
    // so a fast-resolving runWorkflow that dispatches workflowStarted
    // synchronously reads the post-action state rather than the pre-action
    // state.
    stateRef.current = result.state;
    setState(result.state);

    for (const entry of result.starts) {
      const wf = workflowsByIdRef.current.get(entry.workflowId);
      if (!wf) {
        // Workflow disappeared between enqueue and start. Recover.
        dispatch({ type: 'dispatchFailed', entryId: entry.id });
        continue;
      }
      void (async () => {
        const run = await runWorkflowRef.current(wf, entry);
        if (run) {
          dispatch({ type: 'workflowStarted', entryId: entry.id, runId: run.id });
        } else {
          dispatch({ type: 'dispatchFailed', entryId: entry.id });
        }
      })();
    }
  }, []);

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
  const prevActiveRef = useRef(activeRuns);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (prev !== activeRuns) {
      for (const id of Object.keys(prev)) {
        if (!activeRuns[id]) {
          const status = recentRunsRef.current[id]?.status ?? 'completed';
          dispatch({ type: 'runFinished', runId: id, status });
        }
      }
      prevActiveRef.current = activeRuns;
    }
  }, [activeRuns, dispatch]);

  return { state, dispatch };
}
