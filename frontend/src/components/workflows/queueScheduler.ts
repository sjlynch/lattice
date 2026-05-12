// Pure workflow-queue scheduler. The state machine is independent of React so
// it can be unit-tested without DOM mocks; the React layer feeds events in
// (`reduceQueue`) and reads back what to start now (`pendingStarts`).
//
// Why a separate module: the previous in-component effect mixed three
// orthogonal concerns — closure of stale state, ref-based reentrancy guards,
// and ordering of optimistic updates vs HTTP awaits. That made the
// sequential-vs-parallel decision easy to subtly break (e.g. starting wf2
// while wf1's HTTP was in flight if a setState boundary fell at the wrong
// place). Pulling the decision into a pure reducer makes the invariants
// explicit and the bugs reachable from tests.

export type QueueMode = 'sequential' | 'parallel';

// One workflow the queue has dispatched a /run for. `runId` is null while the
// HTTP request is in flight; once the backend responds with the run object
// (or, equivalently, the WS `started` event arrives) we tag it with the run
// id so the run-lifecycle WS events can find this entry to retire it.
export type StartedEntry = {
  workflowId: string;
  runId: string | null;
};

export type QueueState = {
  mode: QueueMode;
  // Workflow IDs waiting to be started, in FIFO order.
  queued: string[];
  // True iff the user pressed Start queue and the scheduler is responsible
  // for auto-progressing. Flips back to false automatically when the queue
  // drains.
  running: boolean;
  // Workflows the queue has dispatched /run for, that we still consider
  // in-flight or active. Sequential mode keeps this at length <= 1; parallel
  // fills it with the whole batch until each run finishes.
  started: StartedEntry[];
};

export const initialQueueState: QueueState = {
  mode: 'sequential',
  queued: [],
  running: false,
  started: [],
};

export type QueueAction =
  | { type: 'setMode'; mode: QueueMode }
  | { type: 'enqueue'; workflowId: string }
  | { type: 'removeFromQueue'; workflowId: string }
  | { type: 'clearQueue' }
  | { type: 'startQueue' }
  | { type: 'stopQueue' }
  // Optimistically mark a workflow as in-flight. Removes it from queued
  // immediately so a second tick of the scheduler doesn't pick it again.
  | { type: 'dispatchStart'; workflowId: string }
  // The /run HTTP succeeded (or WS `started` arrived first — same outcome):
  // attach the runId to the in-flight entry so a later runFinished can match.
  | { type: 'workflowStarted'; workflowId: string; runId: string }
  // The /run HTTP errored or threw client-side. The run never existed
  // server-side from the queue's perspective.
  | { type: 'dispatchFailed'; workflowId: string }
  // A run finished server-side (WS completed/cancelled/errored). Matched by
  // runId because workflowId alone is ambiguous if the same workflow was
  // queued + run multiple times.
  | { type: 'runFinished'; runId: string };

// Pure reducer. No I/O, no side effects.
export function reduceQueue(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'setMode': {
      // Disallow mid-flight mode changes — semantics would be murky
      // (mid-parallel switching to sequential, or vice versa). The UI also
      // disables the buttons while running, so this is a defensive check.
      if (state.running || state.started.length > 0) return state;
      if (state.mode === action.mode) return state;
      return { ...state, mode: action.mode };
    }

    case 'enqueue': {
      if (state.queued.includes(action.workflowId)) return state;
      // Don't re-queue a workflow that's currently in-flight. Avoids a
      // second /run getting dispatched the moment the first one finishes.
      if (state.started.some((s) => s.workflowId === action.workflowId)) {
        return state;
      }
      return { ...state, queued: [...state.queued, action.workflowId] };
    }

    case 'removeFromQueue': {
      if (!state.queued.includes(action.workflowId)) return state;
      return {
        ...state,
        queued: state.queued.filter((id) => id !== action.workflowId),
      };
    }

    case 'clearQueue': {
      if (state.queued.length === 0) return state;
      return { ...state, queued: [] };
    }

    case 'startQueue': {
      if (state.running) return state;
      if (state.queued.length === 0) return state;
      return { ...state, running: true };
    }

    case 'stopQueue': {
      if (!state.running) return state;
      return { ...state, running: false };
    }

    case 'dispatchStart': {
      // Idempotent: already in-flight = no-op. This is the synchronous gate
      // that prevents the React layer from dispatching /run twice for the
      // same workflow id, even if pendingStarts is called more than once
      // before state propagates.
      if (state.started.some((s) => s.workflowId === action.workflowId)) {
        return state;
      }
      return {
        ...state,
        queued: state.queued.filter((id) => id !== action.workflowId),
        started: [
          ...state.started,
          { workflowId: action.workflowId, runId: null },
        ],
      };
    }

    case 'workflowStarted': {
      // Attach the runId to the matching in-flight entry. Match by
      // workflowId + runId=null because the same workflowId could
      // theoretically appear twice in parallel mode (the enqueue guard
      // prevents this today, but the reducer shouldn't rely on it).
      let attached = false;
      const next = state.started.map((s) => {
        if (attached) return s;
        if (s.workflowId === action.workflowId && s.runId === null) {
          attached = true;
          return { ...s, runId: action.runId };
        }
        return s;
      });
      if (!attached) return state;
      return { ...state, started: next };
    }

    case 'dispatchFailed': {
      // Remove the most recent in-flight entry for this workflow. Only one
      // can exist at a time given the dispatchStart guard.
      const idx = state.started.findIndex(
        (s) => s.workflowId === action.workflowId && s.runId === null,
      );
      if (idx === -1) return state;
      const started = [...state.started];
      started.splice(idx, 1);
      return { ...state, started };
    }

    case 'runFinished': {
      const idx = state.started.findIndex((s) => s.runId === action.runId);
      if (idx === -1) return state;
      const started = [...state.started];
      started.splice(idx, 1);
      return { ...state, started };
    }
  }
}

// What the scheduler wants the React layer to start *now*. Pure — safe to
// call after every action.
//
// Sequential: at most one workflow may be in-flight or active at a time.
// Parallel: every queued workflow not already in-flight should fire now.
export function pendingStarts(state: QueueState): string[] {
  if (!state.running) return [];
  if (state.queued.length === 0) return [];
  if (state.mode === 'sequential') {
    if (state.started.length > 0) return [];
    return [state.queued[0]];
  }
  const startedSet = new Set(state.started.map((s) => s.workflowId));
  return state.queued.filter((id) => !startedSet.has(id));
}

// Whether the queue has nothing left to do. Used by the runtime to flip
// `running` back to false automatically — saves the user from having to
// click Stop after a sequential queue finishes its last workflow.
export function shouldAutoStop(state: QueueState): boolean {
  if (!state.running) return false;
  if (state.queued.length > 0) return false;
  if (state.mode === 'sequential') {
    // Drained iff no workflow is in-flight or active.
    return state.started.length === 0;
  }
  // Parallel mode is fire-and-forget: as soon as every queued workflow has
  // either dispatched successfully (runId attached) or failed-and-cleared,
  // the queue's job is done. Outstanding runs continue independently.
  return state.started.every((s) => s.runId !== null);
}

// Convenience: apply one action and return both the new state and the
// derived next operations. The runtime calls this once per dispatch and
// either fires the returned starts (HTTP /run) or auto-stops.
export type Step = {
  state: QueueState;
  starts: string[];
  autoStop: boolean;
};

export function step(state: QueueState, action: QueueAction): Step {
  let next = reduceQueue(state, action);
  const starts = pendingStarts(next);
  // Apply the dispatchStart optimistic updates synchronously so the caller's
  // next call to `step` doesn't re-emit them.
  for (const workflowId of starts) {
    next = reduceQueue(next, { type: 'dispatchStart', workflowId });
  }
  let autoStop = false;
  if (shouldAutoStop(next)) {
    next = reduceQueue(next, { type: 'stopQueue' });
    autoStop = true;
  }
  return { state: next, starts, autoStop };
}
