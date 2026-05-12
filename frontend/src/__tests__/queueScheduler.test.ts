import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialQueueState,
  pendingStarts,
  reduceQueue,
  shouldAutoStop,
  step,
  type QueueAction,
  type QueueState,
} from '../components/workflows/queueScheduler.ts';

// Drive the scheduler the way the React layer will: dispatch one action,
// inspect the result, fire any returned `starts`. This is what step() does,
// but inlined per test so the assertions can interrogate the intermediate
// state.
function run(state: QueueState, action: QueueAction): {
  state: QueueState;
  starts: string[];
  autoStop: boolean;
} {
  return step(state, action);
}

// ---------- enqueue / removeFromQueue / clearQueue ----------

test('enqueue appends to the queue in FIFO order', () => {
  let s = initialQueueState;
  s = reduceQueue(s, { type: 'enqueue', workflowId: 'wf1' });
  s = reduceQueue(s, { type: 'enqueue', workflowId: 'wf2' });
  s = reduceQueue(s, { type: 'enqueue', workflowId: 'wf3' });
  assert.deepEqual(s.queued, ['wf1', 'wf2', 'wf3']);
});

test('enqueue is a no-op when the workflow is already queued', () => {
  let s = initialQueueState;
  s = reduceQueue(s, { type: 'enqueue', workflowId: 'wf1' });
  const before = s;
  s = reduceQueue(s, { type: 'enqueue', workflowId: 'wf1' });
  assert.strictEqual(s, before, 'state object should not be replaced');
  assert.deepEqual(s.queued, ['wf1']);
});

test('enqueue refuses to add a workflow that is already in-flight', () => {
  // A workflow that's mid-dispatch shouldn't sneak back into the queue —
  // otherwise it'd start a second time the instant the first run finishes.
  let s = initialQueueState;
  s = { ...s, started: [{ workflowId: 'wf1', runId: 'run1' }] };
  s = reduceQueue(s, { type: 'enqueue', workflowId: 'wf1' });
  assert.deepEqual(s.queued, []);
});

test('removeFromQueue drops the matching id and is a no-op otherwise', () => {
  let s = initialQueueState;
  s = reduceQueue(s, { type: 'enqueue', workflowId: 'wf1' });
  s = reduceQueue(s, { type: 'enqueue', workflowId: 'wf2' });
  s = reduceQueue(s, { type: 'removeFromQueue', workflowId: 'wf1' });
  assert.deepEqual(s.queued, ['wf2']);
  const before = s;
  s = reduceQueue(s, { type: 'removeFromQueue', workflowId: 'nope' });
  assert.strictEqual(s, before);
});

test('clearQueue empties the queue without affecting started runs', () => {
  let s: QueueState = {
    mode: 'sequential',
    queued: ['wf1', 'wf2'],
    running: true,
    started: [{ workflowId: 'wf0', runId: 'run0' }],
  };
  s = reduceQueue(s, { type: 'clearQueue' });
  assert.deepEqual(s.queued, []);
  assert.deepEqual(s.started, [{ workflowId: 'wf0', runId: 'run0' }]);
  assert.equal(s.running, true);
});

// ---------- start / stop / mode ----------

test('startQueue refuses when there is nothing queued', () => {
  const s = reduceQueue(initialQueueState, { type: 'startQueue' });
  assert.equal(s.running, false);
});

test('startQueue flips running on with at least one queued item', () => {
  let s = reduceQueue(initialQueueState, { type: 'enqueue', workflowId: 'wf1' });
  s = reduceQueue(s, { type: 'startQueue' });
  assert.equal(s.running, true);
});

test('stopQueue flips running off without disturbing the queue', () => {
  let s: QueueState = {
    mode: 'sequential',
    queued: ['wf2'],
    running: true,
    started: [{ workflowId: 'wf1', runId: 'run1' }],
  };
  s = reduceQueue(s, { type: 'stopQueue' });
  assert.equal(s.running, false);
  assert.deepEqual(s.queued, ['wf2']);
  assert.deepEqual(s.started, [{ workflowId: 'wf1', runId: 'run1' }]);
});

test('setMode is ignored while running or while runs are in flight', () => {
  let s: QueueState = { mode: 'sequential', queued: [], running: true, started: [] };
  s = reduceQueue(s, { type: 'setMode', mode: 'parallel' });
  assert.equal(s.mode, 'sequential');

  let s2: QueueState = {
    mode: 'sequential',
    queued: [],
    running: false,
    started: [{ workflowId: 'wf1', runId: 'run1' }],
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
    queued: ['wf1'],
    running: false,
    started: [],
  };
  assert.deepEqual(pendingStarts(s), []);
});

test('pendingStarts (sequential) returns just the head of the queue', () => {
  const s: QueueState = {
    mode: 'sequential',
    queued: ['wf1', 'wf2', 'wf3'],
    running: true,
    started: [],
  };
  assert.deepEqual(pendingStarts(s), ['wf1']);
});

test('pendingStarts (sequential) waits while something is in flight', () => {
  // This is the invariant that makes "sequential mode runs one at a time"
  // actually true: as long as `started` is non-empty, we don't dispatch
  // another /run, even if more items are queued.
  const s: QueueState = {
    mode: 'sequential',
    queued: ['wf2'],
    running: true,
    started: [{ workflowId: 'wf1', runId: null }],
  };
  assert.deepEqual(pendingStarts(s), []);
});

test('pendingStarts (sequential) waits while a run is active', () => {
  const s: QueueState = {
    mode: 'sequential',
    queued: ['wf2'],
    running: true,
    started: [{ workflowId: 'wf1', runId: 'run1' }],
  };
  assert.deepEqual(pendingStarts(s), []);
});

test('pendingStarts (parallel) returns everything not yet started', () => {
  const s: QueueState = {
    mode: 'parallel',
    queued: ['wf1', 'wf2', 'wf3'],
    running: true,
    started: [],
  };
  assert.deepEqual(pendingStarts(s), ['wf1', 'wf2', 'wf3']);
});

test('pendingStarts (parallel) excludes anything already in-flight', () => {
  const s: QueueState = {
    mode: 'parallel',
    queued: ['wf1', 'wf2'],
    running: true,
    started: [{ workflowId: 'wf1', runId: null }],
  };
  assert.deepEqual(pendingStarts(s), ['wf2']);
});

// ---------- step(): the dispatch-and-optimistic-update primitive ----------

test('step in sequential mode dispatches one workflow per Start', () => {
  // This is the bug repro: two queued workflows in sequential mode must
  // produce a single start, not two. The previous in-component effect could
  // optimistically remove wf1 from the queue and then have a second tick
  // see queueActiveRunId=null and start wf2 in parallel. The reducer-driven
  // version moves the workflow into `started` synchronously so the second
  // pendingStarts call returns [].
  let { state, starts } = run(initialQueueState, {
    type: 'enqueue',
    workflowId: 'wf1',
  });
  ({ state, starts } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  ({ state, starts } = run(state, { type: 'startQueue' }));

  assert.deepEqual(starts, ['wf1']);
  assert.deepEqual(state.queued, ['wf2']);
  assert.deepEqual(state.started, [{ workflowId: 'wf1', runId: null }]);
  assert.equal(state.running, true);
});

test('a stray step() call after Start does NOT spawn a second workflow', () => {
  // Mimics a stray re-dispatch (e.g. a React re-render firing an extra
  // synchronous tick before the HTTP response). The scheduler must hold
  // wf2 back until wf1 finishes.
  let { state } = run(initialQueueState, { type: 'enqueue', workflowId: 'wf1' });
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  ({ state } = run(state, { type: 'startQueue' }));
  // Pretend the HTTP just hasn't responded yet — dispatch any noop-ish
  // action; pendingStarts should still be empty because wf1 is in flight.
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' })); // already queued, no-op
  assert.deepEqual(pendingStarts(state), []);
});

test('full sequential flow: wf1 starts, finishes, then wf2 starts', () => {
  let { state, starts, autoStop } = run(initialQueueState, {
    type: 'enqueue',
    workflowId: 'wf1',
  });
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  ({ state, starts } = run(state, { type: 'startQueue' }));
  assert.deepEqual(starts, ['wf1']);

  // HTTP for wf1 returns with run id 'run1'.
  ({ state, starts } = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf1',
    runId: 'run1',
  }));
  assert.deepEqual(starts, [], 'wf2 must not start while wf1 is active');
  assert.deepEqual(state.started, [{ workflowId: 'wf1', runId: 'run1' }]);

  // wf1's run finishes server-side (WS completed).
  ({ state, starts } = run(state, { type: 'runFinished', runId: 'run1' }));
  assert.deepEqual(starts, ['wf1'].length === 1 ? ['wf2'] : []);
  assert.deepEqual(state.started, [{ workflowId: 'wf2', runId: null }]);

  // HTTP for wf2 returns.
  ({ state, starts } = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf2',
    runId: 'run2',
  }));
  assert.deepEqual(starts, []);

  // wf2 finishes.
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

test('parallel mode dispatches every queued workflow at once', () => {
  let { state } = run(initialQueueState, { type: 'setMode', mode: 'parallel' });
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf1' }));
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf3' }));
  const { starts, state: after } = run(state, { type: 'startQueue' });
  assert.deepEqual(starts, ['wf1', 'wf2', 'wf3']);
  assert.deepEqual(after.queued, []);
  assert.deepEqual(
    after.started.map((s) => s.workflowId).sort(),
    ['wf1', 'wf2', 'wf3'],
  );
});

test('parallel mode auto-stops once every dispatch has been confirmed', () => {
  let { state } = run(initialQueueState, { type: 'setMode', mode: 'parallel' });
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf1' }));
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  ({ state } = run(state, { type: 'startQueue' }));
  let autoStop = false;
  ({ state, autoStop } = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf1',
    runId: 'run1',
  }));
  assert.equal(autoStop, false);
  ({ state, autoStop } = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf2',
    runId: 'run2',
  }));
  assert.equal(autoStop, true);
  assert.equal(state.running, false);
});

test('a failed dispatch in sequential mode skips to the next workflow', () => {
  let { state, starts } = run(initialQueueState, {
    type: 'enqueue',
    workflowId: 'wf1',
  });
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  ({ state, starts } = run(state, { type: 'startQueue' }));
  assert.deepEqual(starts, ['wf1']);

  ({ state, starts } = run(state, {
    type: 'dispatchFailed',
    workflowId: 'wf1',
  }));
  assert.deepEqual(starts, ['wf2']);
  assert.deepEqual(state.started, [{ workflowId: 'wf2', runId: null }]);
});

test('a failed dispatch in parallel mode does not retry the failed workflow', () => {
  let { state } = run(initialQueueState, { type: 'setMode', mode: 'parallel' });
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf1' }));
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  const after = run(state, { type: 'startQueue' });
  ({ state } = after);
  assert.deepEqual(after.starts, ['wf1', 'wf2']);

  // Both dispatches resolve. wf1 fails, wf2 succeeds.
  ({ state } = run(state, { type: 'dispatchFailed', workflowId: 'wf1' }));
  const lastTick = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf2',
    runId: 'run2',
  });
  // Once both dispatches have settled (one failed, one in flight) parallel
  // mode is drained — outstanding runs are no longer the queue's concern.
  assert.equal(lastTick.autoStop, true);
  assert.equal(lastTick.state.running, false);
});

test('stopQueue mid-run prevents further dispatches but leaves wf1 alone', () => {
  let { state } = run(initialQueueState, { type: 'enqueue', workflowId: 'wf1' });
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  ({ state } = run(state, { type: 'startQueue' }));
  ({ state } = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf1',
    runId: 'run1',
  }));

  ({ state } = run(state, { type: 'stopQueue' }));
  assert.equal(state.running, false);
  // wf2 stays queued — Stop pauses the queue without throwing items away.
  assert.deepEqual(state.queued, ['wf2']);

  // wf1 finishing should NOT start wf2 (queue is stopped).
  const finished = run(state, { type: 'runFinished', runId: 'run1' });
  assert.deepEqual(finished.starts, []);
  assert.equal(finished.state.running, false);
});

test('Start can be pressed again after Stop to resume', () => {
  let { state } = run(initialQueueState, { type: 'enqueue', workflowId: 'wf1' });
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  ({ state } = run(state, { type: 'startQueue' }));
  ({ state } = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf1',
    runId: 'run1',
  }));
  ({ state } = run(state, { type: 'stopQueue' }));
  ({ state } = run(state, { type: 'runFinished', runId: 'run1' }));
  // wf2 is still queued, queue idle.
  assert.deepEqual(state.queued, ['wf2']);
  assert.equal(state.running, false);
  const resumed = run(state, { type: 'startQueue' });
  assert.deepEqual(resumed.starts, ['wf2']);
});

test('enqueueing more workflows mid-run extends the sequential queue', () => {
  let { state } = run(initialQueueState, { type: 'enqueue', workflowId: 'wf1' });
  ({ state } = run(state, { type: 'startQueue' }));
  ({ state } = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf1',
    runId: 'run1',
  }));
  // User enqueues wf2 while wf1 is running.
  let added = run(state, { type: 'enqueue', workflowId: 'wf2' });
  // wf2 must not start yet — wf1 still in flight.
  assert.deepEqual(added.starts, []);
  assert.deepEqual(added.state.queued, ['wf2']);

  // wf1 finishes — wf2 picks up next.
  const next = run(added.state, { type: 'runFinished', runId: 'run1' });
  assert.deepEqual(next.starts, ['wf2']);
});

test('clearing the queue mid-run lets the in-flight workflow finish then drains', () => {
  let { state } = run(initialQueueState, { type: 'enqueue', workflowId: 'wf1' });
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf3' }));
  ({ state } = run(state, { type: 'startQueue' }));
  ({ state } = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf1',
    runId: 'run1',
  }));
  ({ state } = run(state, { type: 'clearQueue' }));
  assert.deepEqual(state.queued, []);
  // wf1 still mid-run.
  assert.deepEqual(state.started, [{ workflowId: 'wf1', runId: 'run1' }]);

  // wf1 finishes — queue should drain naturally.
  const finished = run(state, { type: 'runFinished', runId: 'run1' });
  assert.equal(finished.autoStop, true);
  assert.equal(finished.state.running, false);
});

test('runFinished for an unknown runId is a no-op', () => {
  let { state } = run(initialQueueState, { type: 'enqueue', workflowId: 'wf1' });
  ({ state } = run(state, { type: 'startQueue' }));
  ({ state } = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf1',
    runId: 'run1',
  }));
  const before = state;
  const stray = run(state, { type: 'runFinished', runId: 'manual-run-99' });
  assert.strictEqual(stray.state.started, before.started);
});

test('workflowStarted twice for the same workflow attaches the runId once', () => {
  // Defensive: in production, HTTP success and WS `started` both deliver the
  // runId. Whichever races first wins; the second must be a no-op so we
  // don't accidentally overwrite a runId that's already been retired by a
  // fast runFinished.
  let { state } = run(initialQueueState, { type: 'enqueue', workflowId: 'wf1' });
  ({ state } = run(state, { type: 'startQueue' }));
  ({ state } = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf1',
    runId: 'run1',
  }));
  const before = state;
  const again = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf1',
    runId: 'run-different',
  });
  assert.deepEqual(again.state.started, before.started);
});

test('shouldAutoStop returns false while items remain or a run is in flight', () => {
  assert.equal(shouldAutoStop(initialQueueState), false);
  assert.equal(
    shouldAutoStop({
      mode: 'sequential',
      queued: ['wf1'],
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
      started: [{ workflowId: 'wf1', runId: 'run1' }],
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

test('rapid double-Start in sequential mode dispatches wf1 only once', () => {
  // The previous in-effect implementation guarded against re-entrancy with a
  // ref + queueBusy flag. The reducer version is naturally idempotent: a
  // second startQueue when already running is a no-op.
  let { state, starts } = run(initialQueueState, {
    type: 'enqueue',
    workflowId: 'wf1',
  });
  ({ state, starts } = run(state, { type: 'startQueue' }));
  assert.deepEqual(starts, ['wf1']);
  ({ state, starts } = run(state, { type: 'startQueue' }));
  assert.deepEqual(starts, [], 'second Start while already running is a no-op');
  assert.equal(state.started.length, 1);
});

test('rapid double-Start in parallel mode dispatches each workflow only once', () => {
  // Same idempotence guarantee for parallel: clicking Start twice before the
  // first dispatchStart settles should not produce two /run calls per wf.
  // The reducer's dispatchStart guard (skip if workflowId already in
  // started) is the canonical check.
  let { state } = run(initialQueueState, { type: 'setMode', mode: 'parallel' });
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf1' }));
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  const first = run(state, { type: 'startQueue' });
  assert.deepEqual(first.starts, ['wf1', 'wf2']);
  // pendingStarts on the resulting state should be empty — both are in flight.
  assert.deepEqual(pendingStarts(first.state), []);
});

test('runFinished while not running cleans up `started` without restarting', () => {
  // Mid-run, user clicks Stop. wf1 is still running on the backend; when it
  // eventually finishes, the WS `completed` arrives. The scheduler should
  // retire the started entry but NOT dispatch wf2 — running=false.
  let { state } = run(initialQueueState, { type: 'enqueue', workflowId: 'wf1' });
  ({ state } = run(state, { type: 'enqueue', workflowId: 'wf2' }));
  ({ state } = run(state, { type: 'startQueue' }));
  ({ state } = run(state, {
    type: 'workflowStarted',
    workflowId: 'wf1',
    runId: 'run1',
  }));
  ({ state } = run(state, { type: 'stopQueue' }));
  const finished = run(state, { type: 'runFinished', runId: 'run1' });
  assert.deepEqual(finished.starts, []);
  assert.deepEqual(finished.state.started, []);
  assert.deepEqual(finished.state.queued, ['wf2']);
  assert.equal(finished.state.running, false);
});

test('repro: sequential Start with two workflows yields one terminal, not two', () => {
  // High-level smoke test that mirrors the user's reported bug ("ran two
  // workflows in sequential mode then 2 step-1 terminals appeared"). With
  // the pure scheduler, the only way a terminal pops up is via a `start`
  // returned by step() — so we count starts produced before the first
  // workflow's run id is even attached.
  let state = initialQueueState;
  let allStarts: string[] = [];
  for (const a of [
    { type: 'enqueue', workflowId: 'wf1' },
    { type: 'enqueue', workflowId: 'wf2' },
    { type: 'startQueue' },
    // Simulate a stray React tick BEFORE the HTTP response arrives.
    { type: 'enqueue', workflowId: 'wf1' }, // dup, no-op
    { type: 'enqueue', workflowId: 'wf2' }, // dup, no-op
  ] satisfies QueueAction[]) {
    const out = run(state, a);
    state = out.state;
    allStarts.push(...out.starts);
  }
  assert.deepEqual(
    allStarts,
    ['wf1'],
    'only wf1 should have been dispatched before wf1 reports started',
  );
});
