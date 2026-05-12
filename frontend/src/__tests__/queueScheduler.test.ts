import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowQueueEntry, WorkflowRunHarnessOverride } from '../api/index.ts';
import {
  initialQueueState,
  pendingStarts,
  reduceQueue,
  shouldAutoStop,
  step,
  type QueueAction,
  type QueueState,
} from '../components/workflows/queueScheduler.ts';

function queued(
  id: string,
  workflowId: string,
  harnessOverride: WorkflowRunHarnessOverride = null,
): WorkflowQueueEntry {
  return { id, workflowId, harnessOverride };
}

function run(state: QueueState, action: QueueAction): {
  state: QueueState;
  starts: WorkflowQueueEntry[];
  autoStop: boolean;
} {
  return step(state, action);
}

function startIds(starts: WorkflowQueueEntry[]): string[] {
  return starts.map((entry) => entry.id);
}

// ---------- enqueue / removeFromQueue / clearQueue ----------

test('enqueue appends independent entries in FIFO order', () => {
  let s = initialQueueState;
  s = reduceQueue(s, { type: 'enqueue', entry: queued('q1', 'wf1') });
  s = reduceQueue(s, { type: 'enqueue', entry: queued('q2', 'wf2') });
  s = reduceQueue(s, { type: 'enqueue', entry: queued('q3', 'wf3') });
  assert.deepEqual(s.queued.map((entry) => entry.id), ['q1', 'q2', 'q3']);
});

test('enqueue allows the same workflow more than once with separate overrides', () => {
  let s = initialQueueState;
  s = reduceQueue(s, { type: 'enqueue', entry: queued('q1', 'wf1', 'claude') });
  s = reduceQueue(s, { type: 'enqueue', entry: queued('q2', 'wf1', 'pi') });
  assert.deepEqual(
    s.queued.map((entry) => ({ workflowId: entry.workflowId, harnessOverride: entry.harnessOverride })),
    [
      { workflowId: 'wf1', harnessOverride: 'claude' },
      { workflowId: 'wf1', harnessOverride: 'pi' },
    ],
  );
});

test('removeFromQueue drops only the matching queued entry id', () => {
  let s = initialQueueState;
  s = reduceQueue(s, { type: 'enqueue', entry: queued('q1', 'wf1') });
  s = reduceQueue(s, { type: 'enqueue', entry: queued('q2', 'wf1') });
  s = reduceQueue(s, { type: 'removeFromQueue', entryId: 'q1' });
  assert.deepEqual(s.queued.map((entry) => entry.id), ['q2']);
  const before = s;
  s = reduceQueue(s, { type: 'removeFromQueue', entryId: 'nope' });
  assert.strictEqual(s, before);
});

test('clearQueue empties queued entries without affecting started runs', () => {
  let s: QueueState = {
    mode: 'sequential',
    queued: [queued('q1', 'wf1'), queued('q2', 'wf2')],
    running: true,
    started: [{ ...queued('q0', 'wf0'), runId: 'run0' }],
  };
  s = reduceQueue(s, { type: 'clearQueue' });
  assert.deepEqual(s.queued, []);
  assert.deepEqual(s.started, [{ ...queued('q0', 'wf0'), runId: 'run0' }]);
  assert.equal(s.running, true);
});

// ---------- start / stop / mode ----------

test('startQueue refuses when there is nothing queued', () => {
  const s = reduceQueue(initialQueueState, { type: 'startQueue' });
  assert.equal(s.running, false);
});

test('startQueue flips running on with at least one queued item', () => {
  let s = reduceQueue(initialQueueState, { type: 'enqueue', entry: queued('q1', 'wf1') });
  s = reduceQueue(s, { type: 'startQueue' });
  assert.equal(s.running, true);
});

test('stopQueue flips running off without disturbing the queue', () => {
  let s: QueueState = {
    mode: 'sequential',
    queued: [queued('q2', 'wf2')],
    running: true,
    started: [{ ...queued('q1', 'wf1'), runId: 'run1' }],
  };
  s = reduceQueue(s, { type: 'stopQueue' });
  assert.equal(s.running, false);
  assert.deepEqual(s.queued, [queued('q2', 'wf2')]);
  assert.deepEqual(s.started, [{ ...queued('q1', 'wf1'), runId: 'run1' }]);
});

test('setMode is ignored while running or while runs are in flight', () => {
  let s: QueueState = { mode: 'sequential', queued: [], running: true, started: [] };
  s = reduceQueue(s, { type: 'setMode', mode: 'parallel' });
  assert.equal(s.mode, 'sequential');

  let s2: QueueState = {
    mode: 'sequential',
    queued: [],
    running: false,
    started: [{ ...queued('q1', 'wf1'), runId: 'run1' }],
  };
  s2 = reduceQueue(s2, { type: 'setMode', mode: 'parallel' });
  assert.equal(s2.mode, 'sequential');
});

test('setMode flips the mode when idle', () => {
  const s = reduceQueue(initialQueueState, { type: 'setMode', mode: 'parallel' });
  assert.equal(s.mode, 'parallel');
});

// ---------- pendingStarts: the heart of the scheduler ----------

test('pendingStarts is empty when not running', () => {
  const s: QueueState = {
    mode: 'sequential',
    queued: [queued('q1', 'wf1')],
    running: false,
    started: [],
  };
  assert.deepEqual(pendingStarts(s), []);
});

test('pendingStarts (sequential) returns just the head of the queue', () => {
  const s: QueueState = {
    mode: 'sequential',
    queued: [queued('q1', 'wf1'), queued('q2', 'wf2')],
    running: true,
    started: [],
  };
  assert.deepEqual(startIds(pendingStarts(s)), ['q1']);
});

test('pendingStarts (sequential) waits while something is in flight or active', () => {
  const inFlight: QueueState = {
    mode: 'sequential',
    queued: [queued('q2', 'wf2')],
    running: true,
    started: [{ ...queued('q1', 'wf1'), runId: null }],
  };
  assert.deepEqual(pendingStarts(inFlight), []);

  const active: QueueState = {
    ...inFlight,
    started: [{ ...queued('q1', 'wf1'), runId: 'run1' }],
  };
  assert.deepEqual(pendingStarts(active), []);
});

test('pendingStarts (parallel) returns every queued entry, including duplicates', () => {
  const s: QueueState = {
    mode: 'parallel',
    queued: [queued('q1', 'wf1'), queued('q2', 'wf1'), queued('q3', 'wf2')],
    running: true,
    started: [],
  };
  assert.deepEqual(startIds(pendingStarts(s)), ['q1', 'q2', 'q3']);
});

test('pendingStarts (parallel) excludes only entries already in-flight', () => {
  const s: QueueState = {
    mode: 'parallel',
    queued: [queued('q1', 'wf1'), queued('q2', 'wf1')],
    running: true,
    started: [{ ...queued('q1', 'wf1'), runId: null }],
  };
  assert.deepEqual(startIds(pendingStarts(s)), ['q2']);
});

// ---------- step(): the dispatch-and-optimistic-update primitive ----------

test('step in sequential mode dispatches one queued entry per Start', () => {
  let { state, starts } = run(initialQueueState, {
    type: 'enqueue',
    entry: queued('q1', 'wf1'),
  });
  ({ state } = run(state, { type: 'enqueue', entry: queued('q2', 'wf2') }));
  ({ state, starts } = run(state, { type: 'startQueue' }));

  assert.deepEqual(startIds(starts), ['q1']);
  assert.deepEqual(state.queued.map((entry) => entry.id), ['q2']);
  assert.deepEqual(state.started, [{ ...queued('q1', 'wf1'), runId: null }]);
  assert.equal(state.running, true);
});

test('full sequential flow: duplicate wf1 entries run one after the other with captured overrides', () => {
  let { state, starts, autoStop } = run(initialQueueState, {
    type: 'enqueue',
    entry: queued('q1', 'wf1', 'claude'),
  });
  ({ state } = run(state, { type: 'enqueue', entry: queued('q2', 'wf1', 'pi') }));
  ({ state, starts } = run(state, { type: 'startQueue' }));
  assert.deepEqual(startIds(starts), ['q1']);
  assert.equal(starts[0].harnessOverride, 'claude');

  ({ state, starts } = run(state, {
    type: 'workflowStarted',
    entryId: 'q1',
    runId: 'run1',
  }));
  assert.deepEqual(starts, [], 'q2 must not start while q1 is active');

  ({ state, starts } = run(state, { type: 'runFinished', runId: 'run1' }));
  assert.deepEqual(startIds(starts), ['q2']);
  assert.equal(starts[0].harnessOverride, 'pi');

  ({ state } = run(state, {
    type: 'workflowStarted',
    entryId: 'q2',
    runId: 'run2',
  }));
  ({ state, starts, autoStop } = run(state, {
    type: 'runFinished',
    runId: 'run2',
  }));
  assert.deepEqual(starts, []);
  assert.equal(autoStop, true, 'queue should auto-stop when fully drained');
  assert.equal(state.running, false);
  assert.deepEqual(state.queued, []);
  assert.deepEqual(state.started, []);
});

test('parallel mode dispatches every queued entry at once', () => {
  let { state } = run(initialQueueState, { type: 'setMode', mode: 'parallel' });
  ({ state } = run(state, { type: 'enqueue', entry: queued('q1', 'wf1') }));
  ({ state } = run(state, { type: 'enqueue', entry: queued('q2', 'wf1') }));
  ({ state } = run(state, { type: 'enqueue', entry: queued('q3', 'wf3') }));
  const { starts, state: after } = run(state, { type: 'startQueue' });
  assert.deepEqual(startIds(starts), ['q1', 'q2', 'q3']);
  assert.deepEqual(after.queued, []);
  assert.deepEqual(after.started.map((entry) => entry.id).sort(), ['q1', 'q2', 'q3']);
});

test('parallel mode auto-stops once every dispatch has been confirmed', () => {
  let { state } = run(initialQueueState, { type: 'setMode', mode: 'parallel' });
  ({ state } = run(state, { type: 'enqueue', entry: queued('q1', 'wf1') }));
  ({ state } = run(state, { type: 'enqueue', entry: queued('q2', 'wf2') }));
  ({ state } = run(state, { type: 'startQueue' }));
  let autoStop = false;
  ({ state, autoStop } = run(state, {
    type: 'workflowStarted',
    entryId: 'q1',
    runId: 'run1',
  }));
  assert.equal(autoStop, false);
  ({ state, autoStop } = run(state, {
    type: 'workflowStarted',
    entryId: 'q2',
    runId: 'run2',
  }));
  assert.equal(autoStop, true);
  assert.equal(state.running, false);
});

test('a failed dispatch in sequential mode skips to the next queued entry', () => {
  let { state, starts } = run(initialQueueState, {
    type: 'enqueue',
    entry: queued('q1', 'wf1'),
  });
  ({ state } = run(state, { type: 'enqueue', entry: queued('q2', 'wf2') }));
  ({ state, starts } = run(state, { type: 'startQueue' }));
  assert.deepEqual(startIds(starts), ['q1']);

  ({ state, starts } = run(state, {
    type: 'dispatchFailed',
    entryId: 'q1',
  }));
  assert.deepEqual(startIds(starts), ['q2']);
  assert.deepEqual(state.started, [{ ...queued('q2', 'wf2'), runId: null }]);
});

test('stopQueue mid-run prevents further dispatches but leaves the active entry alone', () => {
  let { state } = run(initialQueueState, { type: 'enqueue', entry: queued('q1', 'wf1') });
  ({ state } = run(state, { type: 'enqueue', entry: queued('q2', 'wf2') }));
  ({ state } = run(state, { type: 'startQueue' }));
  ({ state } = run(state, {
    type: 'workflowStarted',
    entryId: 'q1',
    runId: 'run1',
  }));

  ({ state } = run(state, { type: 'stopQueue' }));
  assert.equal(state.running, false);
  assert.deepEqual(state.queued, [queued('q2', 'wf2')]);

  const finished = run(state, { type: 'runFinished', runId: 'run1' });
  assert.deepEqual(finished.starts, []);
  assert.equal(finished.state.running, false);
  assert.deepEqual(finished.state.started, []);
});

test('workflowStarted twice for the same entry attaches the runId once', () => {
  let { state } = run(initialQueueState, { type: 'enqueue', entry: queued('q1', 'wf1') });
  ({ state } = run(state, { type: 'startQueue' }));
  ({ state } = run(state, {
    type: 'workflowStarted',
    entryId: 'q1',
    runId: 'run1',
  }));
  const before = state;
  const again = run(state, {
    type: 'workflowStarted',
    entryId: 'q1',
    runId: 'run-different',
  });
  assert.deepEqual(again.state.started, before.started);
});

test('shouldAutoStop returns false while items remain or a run is in flight', () => {
  assert.equal(shouldAutoStop(initialQueueState), false);
  assert.equal(
    shouldAutoStop({
      mode: 'sequential',
      queued: [queued('q1', 'wf1')],
      running: true,
      started: [],
    }),
    false,
  );
  assert.equal(
    shouldAutoStop({
      mode: 'sequential',
      queued: [],
      running: true,
      started: [{ ...queued('q1', 'wf1'), runId: 'run1' }],
    }),
    false,
  );
  assert.equal(
    shouldAutoStop({
      mode: 'sequential',
      queued: [],
      running: true,
      started: [],
    }),
    true,
  );
});

test('rapid double-Start in sequential mode dispatches the head entry only once', () => {
  let { state, starts } = run(initialQueueState, {
    type: 'enqueue',
    entry: queued('q1', 'wf1'),
  });
  ({ state, starts } = run(state, { type: 'startQueue' }));
  assert.deepEqual(startIds(starts), ['q1']);
  ({ state, starts } = run(state, { type: 'startQueue' }));
  assert.deepEqual(starts, [], 'second Start while already running is a no-op');
  assert.equal(state.started.length, 1);
});
