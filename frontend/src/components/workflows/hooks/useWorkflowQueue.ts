import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workflow, WorkflowRun } from '../../../api';
import {
  initialQueueState,
  step,
  type QueueAction,
  type QueueState,
} from '../queueScheduler';

type Args = {
  workflowsById: Map<string, Workflow>;
  // Triggers an HTTP /run for the given workflow. Returns the run record on
  // success and null on failure (e.g. backend rejected, network error).
  runWorkflow: (wf: Workflow) => Promise<WorkflowRun | null>;
  // Current set of runs the backend considers active (driven by the
  // /ws/workflow-runs `hello`/`started`/`progress`/`completed` events).
  activeRuns: Record<string, WorkflowRun>;
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
}: Args): { state: QueueState; dispatch: (action: QueueAction) => void } {
  const [state, setState] = useState<QueueState>(initialQueueState);

  // Mirrored into refs so `dispatch` can stay stable (empty deps) while
  // still reading the freshest values. A stable dispatch keeps the
  // activeRuns-diff effect from re-running on every render.
  const stateRef = useRef(state);
  const workflowsByIdRef = useRef(workflowsById);
  const runWorkflowRef = useRef(runWorkflow);
  stateRef.current = state;
  workflowsByIdRef.current = workflowsById;
  runWorkflowRef.current = runWorkflow;

  const dispatch = useCallback((action: QueueAction) => {
    const result = step(stateRef.current, action);
    // Apply the new state to the ref BEFORE the recursive dispatches below,
    // so a fast-resolving runWorkflow that dispatches workflowStarted
    // synchronously reads the post-action state rather than the pre-action
    // state.
    stateRef.current = result.state;
    setState(result.state);

    for (const workflowId of result.starts) {
      const wf = workflowsByIdRef.current.get(workflowId);
      if (!wf) {
        // Workflow disappeared between enqueue and start. Recover.
        dispatch({ type: 'dispatchFailed', workflowId });
        continue;
      }
      void (async () => {
        const run = await runWorkflowRef.current(wf);
        if (run) {
          dispatch({ type: 'workflowStarted', workflowId, runId: run.id });
        } else {
          dispatch({ type: 'dispatchFailed', workflowId });
        }
      })();
    }
  }, []);

  // Watch `activeRuns` for runs that disappeared since the last render —
  // that's the signal the workflow finished. Dispatch runFinished so the
  // scheduler can pick up the next queued workflow (sequential) or auto-stop
  // (parallel). runFinished against an id we never tracked is a no-op in the
  // reducer, so a manually-started run leaving activeRuns is harmless.
  const prevActiveRef = useRef(activeRuns);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (prev !== activeRuns) {
      for (const id of Object.keys(prev)) {
        if (!activeRuns[id]) {
          dispatch({ type: 'runFinished', runId: id });
        }
      }
      prevActiveRef.current = activeRuns;
    }
  }, [activeRuns, dispatch]);

  return { state, dispatch };
}
