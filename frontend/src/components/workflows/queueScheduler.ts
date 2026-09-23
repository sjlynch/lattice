// Pure workflow-queue scheduler. The state machine is independent of React so
// it can be unit-tested without DOM mocks; the React layer feeds events in
// (`reduceQueue`) and reads back what to start now (`pendingStarts`).
//
// The queue is strictly sequential: a project runs one workflow at a time (the
// backend 409s a second start), so the next queued entry starts only once the
// active run finishes.
//
// Why a separate module: the previous in-component effect mixed three
// orthogonal concerns — closure of stale state, ref-based reentrancy guards,
// and ordering of optimistic updates vs HTTP awaits. That made the one-at-a-
// time decision easy to subtly break (e.g. starting wf2 while wf1's HTTP was
// in flight if a setState boundary fell at the wrong place). Pulling the
// decision into a pure reducer makes the invariants explicit and the bugs
// reachable from tests.

import type { WorkflowQueueEntry, WorkflowRunStatus } from '../../api';

// One queued entry the scheduler has dispatched a /run for. `runId` is null
// while the HTTP request is in flight; once the backend responds with the run
// object (or, equivalently, the WS `started` event arrives) we tag it with the
// run id so the run-lifecycle WS events can find this entry to retire it.
export type StartedEntry = WorkflowQueueEntry & {
  runId: string | null;
};

export type QueueState = {
  // Independent queued workflow entries waiting to be started, in FIFO order.
  // The same workflowId may appear multiple times with different overrides.
  queued: WorkflowQueueEntry[];
  // True iff the scheduler is responsible for auto-progressing. Set when the
  // user presses Start queue, and *also* auto-set when a workflow is enqueued
  // while another run is already in flight (so "queue it while one is playing"
  // runs the new entry without a second click). Flips back to false
  // automatically when the queue drains.
  running: boolean;
  // Queue entries the queue has dispatched /run for, that we still consider
  // in-flight or active. At most one at a time.
  started: StartedEntry[];
  // Run IDs whose `runFinished` action arrived before `workflowStarted` could
  // attach them to a started entry — i.e. the run finished server-side faster
  // than the /run HTTP response made it back. `workflowStarted` consumes
  // these to retire the entry immediately rather than attaching a runId that
  // is already dead. Without this, the queue stalls after the first
  // workflow when the run completes (or is cancelled) before /run resolves.
  preFinishedRunIds: string[];
};

// Cap on preFinishedRunIds. The set should normally drain immediately when
// workflowStarted fires, but a manual run completing while the queue is also
// active will push an unmatched runId in. Bounding the list prevents
// long-lived queues from accumulating without limit.
const PRE_FINISHED_CAP = 16;

export const initialQueueState: QueueState = {
  queued: [],
  running: false,
  started: [],
  preFinishedRunIds: [],
};

export type QueueAction =
  | { type: 'enqueue'; entry: WorkflowQueueEntry }
  | { type: 'removeFromQueue'; entryId: string }
  | { type: 'clearQueue' }
  | { type: 'startQueue' }
  | { type: 'stopQueue' }
  // Optimistically mark a queued entry as in-flight. Removes it from queued
  // immediately so a second tick of the scheduler doesn't pick it again.
  | { type: 'dispatchStart'; entryId: string }
  // The /run HTTP succeeded (or WS `started` arrived first — same outcome):
  // attach the runId to the in-flight entry so a later runFinished can match.
  | { type: 'workflowStarted'; entryId: string; runId: string }
  // The /run HTTP errored or threw client-side. The run never existed
  // server-side from the queue's perspective.
  | { type: 'dispatchFailed'; entryId: string }
  // The /run HTTP returned 409 — the backend's authoritative one-run-per-project
  // guard rejected the start because a run is already active for the project. Unlike
  // dispatchFailed this is NOT a failure: put the entry back at the FRONT of
  // the queue so it retries once the active run frees the slot (the next
  // runFinished re-evaluates pendingStarts). Closes the startup-window /
  // multi-tab race the frontend-only externalActiveCount gate can't see.
  | { type: 'dispatchRejected'; entryId: string }
  // A run finished server-side (WS completed/cancelled/errored). Matched by
  // runId because workflowId alone is ambiguous when the same workflow is
  // queued multiple times. `status` lets the queue bail when a
  // workflow errored or was cancelled instead of cascading into the next
  // queued workflow as if nothing went wrong. Optional for backward-compat
  // with callers (and tests) that don't track status; missing defaults to
  // 'completed'.
  | { type: 'runFinished'; runId: string; status?: WorkflowRunStatus };

type QueueMutationAction = Extract<
  QueueAction,
  { type: 'enqueue' | 'removeFromQueue' | 'clearQueue' }
>;
type RunningAction = Extract<QueueAction, { type: 'startQueue' | 'stopQueue' }>;
type DispatchLifecycleAction = Extract<
  QueueAction,
  { type: 'dispatchStart' | 'workflowStarted' | 'dispatchFailed' | 'dispatchRejected' }
>;
type RunLifecycleAction = Extract<QueueAction, { type: 'runFinished' }>;

function replaceStartedEntry(
  started: StartedEntry[],
  idx: number,
  entry: StartedEntry,
): StartedEntry[] {
  const next = [...started];
  next[idx] = entry;
  return next;
}

function removeStartedEntry(started: StartedEntry[], idx: number): StartedEntry[] {
  const next = [...started];
  next.splice(idx, 1);
  return next;
}

function removeAt<T>(list: T[], idx: number): T[] {
  const next = [...list];
  next.splice(idx, 1);
  return next;
}

function reduceQueueMutation(state: QueueState, action: QueueMutationAction): QueueState {
  switch (action.type) {
    case 'enqueue':
      return { ...state, queued: [...state.queued, action.entry] };

    case 'removeFromQueue': {
      if (!state.queued.some((entry) => entry.id === action.entryId)) return state;
      return {
        ...state,
        queued: state.queued.filter((entry) => entry.id !== action.entryId),
      };
    }

    case 'clearQueue':
      if (state.queued.length === 0) return state;
      return { ...state, queued: [] };
  }
}

function reduceRunning(state: QueueState, action: RunningAction): QueueState {
  switch (action.type) {
    case 'startQueue':
      if (state.running) return state;
      if (state.queued.length === 0) return state;
      return { ...state, running: true };

    case 'stopQueue':
      if (!state.running) return state;
      return { ...state, running: false };
  }
}

function reduceDispatchLifecycle(state: QueueState, action: DispatchLifecycleAction): QueueState {
  switch (action.type) {
    case 'dispatchStart': {
      // Idempotent by queue-entry id: already in-flight = no-op. This is the
      // synchronous gate that prevents the React layer from dispatching /run
      // twice for the same queued entry, while still allowing the same
      // workflowId to be queued in another independent entry.
      if (state.started.some((entry) => entry.id === action.entryId)) return state;

      const entry = state.queued.find((queued) => queued.id === action.entryId);
      if (!entry) return state;

      return {
        ...state,
        queued: state.queued.filter((queued) => queued.id !== action.entryId),
        started: [...state.started, { ...entry, runId: null }],
      };
    }

    case 'workflowStarted': {
      const idx = state.started.findIndex(
        (entry) => entry.id === action.entryId && entry.runId === null,
      );
      if (idx === -1) return state;

      const preIdx = state.preFinishedRunIds.indexOf(action.runId);
      if (preIdx !== -1) {
        // The run already finished server-side before we could attach the
        // runId. Skip attachment and retire the entry now.
        return {
          ...state,
          started: removeStartedEntry(state.started, idx),
          preFinishedRunIds: removeAt(state.preFinishedRunIds, preIdx),
        };
      }

      return {
        ...state,
        started: replaceStartedEntry(state.started, idx, {
          ...state.started[idx],
          runId: action.runId,
        }),
      };
    }

    case 'dispatchFailed': {
      const idx = state.started.findIndex(
        (entry) => entry.id === action.entryId && entry.runId === null,
      );
      if (idx === -1) return state;
      return { ...state, started: removeStartedEntry(state.started, idx) };
    }

    case 'dispatchRejected': {
      // 409 "slot busy": move the entry out of `started` and back to the FRONT
      // of `queued` so it's the next to retry (preserving FIFO intent). The
      // subsequent `step` re-evaluates pendingStarts — it re-dispatches only if
      // the slot is genuinely free now, otherwise the entry waits for the
      // active run's runFinished. `running` is intentionally left on.
      const idx = state.started.findIndex(
        (entry) => entry.id === action.entryId && entry.runId === null,
      );
      if (idx === -1) return state;
      const rejected = state.started[idx];
      const requeued: WorkflowQueueEntry = {
        id: rejected.id,
        workflowId: rejected.workflowId,
        harnessOverride: rejected.harnessOverride,
        // Only carry the model key when it was set — keep the entry shape
        // identical to the original enqueue (no explicit `undefined`).
        ...(rejected.piModelOverride !== undefined
          ? { piModelOverride: rejected.piModelOverride }
          : {}),
      };
      return {
        ...state,
        started: removeStartedEntry(state.started, idx),
        queued: [requeued, ...state.queued],
      };
    }
  }
}

function reduceRunLifecycle(state: QueueState, action: RunLifecycleAction): QueueState {
  const status = action.status ?? 'completed';
  const idx = state.started.findIndex((entry) => entry.runId === action.runId);
  if (idx === -1) {
    // The runId hasn't been attached yet (race: WS completed/cancelled
    // arrived before /run HTTP resolved) or it belongs to a manual run we
    // never tracked. Remember it so a later workflowStarted can retire the
    // entry instead of attaching a dead runId; an unmatched id ages out via
    // PRE_FINISHED_CAP.
    if (state.preFinishedRunIds.includes(action.runId)) return state;
    const next = [...state.preFinishedRunIds, action.runId];
    return {
      ...state,
      preFinishedRunIds:
        next.length > PRE_FINISHED_CAP ? next.slice(next.length - PRE_FINISHED_CAP) : next,
    };
  }
  const cleared: QueueState = {
    ...state,
    started: removeStartedEntry(state.started, idx),
  };
  // The queue must NOT cascade into the next queued workflow when a workflow
  // errored or was cancelled — otherwise one bad run takes down the rest of
  // the pipeline silently. Stop running; the remaining queued entries stay so
  // the user can inspect and resume.
  if (status !== 'completed' && cleared.running) {
    return reduceRunning(cleared, { type: 'stopQueue' });
  }
  return cleared;
}

// Pure reducer. No I/O, no side effects.
export function reduceQueue(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'enqueue':
    case 'removeFromQueue':
    case 'clearQueue':
      return reduceQueueMutation(state, action);

    case 'startQueue':
    case 'stopQueue':
      return reduceRunning(state, action);

    case 'dispatchStart':
    case 'workflowStarted':
    case 'dispatchFailed':
    case 'dispatchRejected':
      return reduceDispatchLifecycle(state, action);

    case 'runFinished':
      return reduceRunLifecycle(state, action);
  }
}

// Context the React layer feeds the scheduler each tick. `externalActiveCount`
// is the number of workflow runs active server-side that the queue itself did
// NOT dispatch — a manual ▶ Run click, or a run started from another browser
// tab. A project admits one workflow at a time, so an external run occupies
// the slot exactly like a queue-owned run; and an external run in flight is
// what makes an enqueue auto-start the queue.
export type StepContext = {
  externalActiveCount: number;
};

const NO_EXTERNAL_RUNS: StepContext = { externalActiveCount: 0 };

// What the scheduler wants the React layer to start *now*. Pure — safe to
// call after every action.
//
// At most one queued entry may be in-flight or active at a time: the slot is
// taken by either a queue-owned run (`started`) or an externally-started run
// (`ctx.externalActiveCount`, see StepContext), and either one makes the next
// queued entry wait.
export function pendingStarts(
  state: QueueState,
  ctx: StepContext = NO_EXTERNAL_RUNS,
): WorkflowQueueEntry[] {
  if (!state.running) return [];
  if (state.queued.length === 0) return [];
  if (state.started.length > 0 || ctx.externalActiveCount > 0) return [];
  return [state.queued[0]];
}

// Whether the queue has nothing left to do — nothing queued and no workflow
// in-flight or active. Used by the runtime to flip `running` back to false
// automatically, which saves the user from having to click Stop after the
// queue finishes its last workflow.
export function shouldAutoStop(state: QueueState): boolean {
  if (!state.running) return false;
  if (state.queued.length > 0) return false;
  return state.started.length === 0;
}

// Convenience: apply one action and return both the new state and the
// derived next operations. The runtime calls this once per dispatch and
// either fires the returned starts (HTTP /run) or auto-stops.
export type Step = {
  state: QueueState;
  starts: WorkflowQueueEntry[];
  autoStop: boolean;
};

function reserveDispatches(state: QueueState, starts: WorkflowQueueEntry[]): QueueState {
  let next = state;
  // Apply the dispatchStart optimistic updates synchronously so the caller's
  // next call to `step` doesn't re-emit them.
  for (const entry of starts) {
    next = reduceDispatchLifecycle(next, { type: 'dispatchStart', entryId: entry.id });
  }
  return next;
}

function stopIfDrained(state: QueueState): Pick<Step, 'state' | 'autoStop'> {
  if (!shouldAutoStop(state)) return { state, autoStop: false };
  return {
    state: reduceRunning(state, { type: 'stopQueue' }),
    autoStop: true,
  };
}

export function step(
  state: QueueState,
  action: QueueAction,
  ctx: StepContext = NO_EXTERNAL_RUNS,
): Step {
  let reduced = reduceQueue(state, action);
  // Auto-start: queueing a workflow while another run is already in flight
  // behaves as if the user had pressed "Start queue" — the new entry runs as
  // soon as the active run frees the slot. Without this, an entry queued
  // during a manual ▶ Run just sits idle because nothing flipped `running` on. Gated on an *external* active
  // run (one the queue itself didn't dispatch): after an explicit Stop queue
  // the lingering run is still in `started`, so enqueueing then must NOT
  // silently resume the queue the user just stopped.
  if (action.type === 'enqueue' && !reduced.running && ctx.externalActiveCount > 0) {
    reduced = reduceRunning(reduced, { type: 'startQueue' });
  }
  const starts = pendingStarts(reduced, ctx);
  const reserved = reserveDispatches(reduced, starts);
  const stopped = stopIfDrained(reserved);
  return { ...stopped, starts };
}
