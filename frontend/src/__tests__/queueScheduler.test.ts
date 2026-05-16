import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialQueueState,
  pendingStarts,
  reduceQueue,
  shouldAutoStop,
} from '../components/workflows/queueScheduler.ts';
import { entryIds, queued, queueState, scenario, started } from './queueScheduler.fixture.ts';

// ---------- enqueue / removeFromQueue / clearQueue ----------

test('enqueue appends independent entries in FIFO order', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .enqueue('q3', 'wf3');

  assert.deepEqual(q.queuedIds(), ['q1', 'q2', 'q3']);
});

test('enqueue allows the same workflow more than once with separate overrides', () => {
  const q = scenario()
    .enqueue('q1', 'wf1', 'claude')
    .enqueue('q2', 'wf1', 'pi');

  assert.deepEqual(
    q.state.queued.map((entry) => ({
      workflowId: entry.workflowId,
      harnessOverride: entry.harnessOverride,
    })),
    [
      { workflowId: 'wf1', harnessOverride: 'claude' },
      { workflowId: 'wf1', harnessOverride: 'pi' },
    ],
  );
});

test('removeFromQueue drops only the matching queued entry id', () => {
  let state = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf1').state;

  state = reduceQueue(state, { type: 'removeFromQueue', entryId: 'q1' });
  assert.deepEqual(entryIds(state.queued), ['q2']);

  const before = state;
  state = reduceQueue(state, { type: 'removeFromQueue', entryId: 'nope' });
  assert.strictEqual(state, before);
});

test('clearQueue empties queued entries without affecting started runs', () => {
  const state = reduceQueue(
    queueState({
      queued: [queued('q1', 'wf1'), queued('q2', 'wf2')],
      running: true,
      started: [started('q0', 'wf0', 'run0')],
    }),
    { type: 'clearQueue' },
  );

  assert.deepEqual(state.queued, []);
  assert.deepEqual(state.started, [started('q0', 'wf0', 'run0')]);
  assert.equal(state.running, true);
});

// ---------- start / stop / mode ----------

test('startQueue refuses when there is nothing queued', () => {
  const state = reduceQueue(initialQueueState, { type: 'startQueue' });
  assert.equal(state.running, false);
});

test('startQueue flips running on with at least one queued item', () => {
  const state = reduceQueue(queueState({ queued: [queued('q1', 'wf1')] }), {
    type: 'startQueue',
  });

  assert.equal(state.running, true);
  assert.deepEqual(state.queued, [queued('q1', 'wf1')]);
});

test('stopQueue flips running off without disturbing the queue', () => {
  const state = reduceQueue(
    queueState({
      queued: [queued('q2', 'wf2')],
      running: true,
      started: [started('q1', 'wf1', 'run1')],
    }),
    { type: 'stopQueue' },
  );

  assert.equal(state.running, false);
  assert.deepEqual(state.queued, [queued('q2', 'wf2')]);
  assert.deepEqual(state.started, [started('q1', 'wf1', 'run1')]);
});

test('setMode is ignored while running or while runs are in flight', () => {
  const running = reduceQueue(queueState({ running: true }), {
    type: 'setMode',
    mode: 'parallel',
  });
  assert.equal(running.mode, 'sequential');

  const inFlight = reduceQueue(
    queueState({ started: [started('q1', 'wf1', 'run1')] }),
    { type: 'setMode', mode: 'parallel' },
  );
  assert.equal(inFlight.mode, 'sequential');
});

test('setMode flips the mode when idle', () => {
  const state = reduceQueue(initialQueueState, { type: 'setMode', mode: 'parallel' });
  assert.equal(state.mode, 'parallel');
});

// ---------- pendingStarts: the heart of the scheduler ----------

test('pendingStarts is empty when not running', () => {
  assert.deepEqual(
    pendingStarts(queueState({ queued: [queued('q1', 'wf1')] })),
    [],
  );
});

test('pendingStarts (sequential) returns just the head of the queue', () => {
  const state = queueState({
    queued: [queued('q1', 'wf1'), queued('q2', 'wf2')],
    running: true,
  });

  assert.deepEqual(entryIds(pendingStarts(state)), ['q1']);
});

test('pendingStarts (sequential) waits while something is in flight or active', () => {
  const inFlight = queueState({
    queued: [queued('q2', 'wf2')],
    running: true,
    started: [started('q1', 'wf1', null)],
  });
  assert.deepEqual(pendingStarts(inFlight), []);

  const active = queueState({
    ...inFlight,
    started: [started('q1', 'wf1', 'run1')],
  });
  assert.deepEqual(pendingStarts(active), []);
});

test('pendingStarts (parallel) returns every queued entry, including duplicates', () => {
  const state = queueState({
    mode: 'parallel',
    queued: [queued('q1', 'wf1'), queued('q2', 'wf1'), queued('q3', 'wf2')],
    running: true,
  });

  assert.deepEqual(entryIds(pendingStarts(state)), ['q1', 'q2', 'q3']);
});

test('pendingStarts (parallel) excludes only entries already in-flight', () => {
  const state = queueState({
    mode: 'parallel',
    queued: [queued('q1', 'wf1'), queued('q2', 'wf1')],
    running: true,
    started: [started('q1', 'wf1', null)],
  });

  assert.deepEqual(entryIds(pendingStarts(state)), ['q2']);
});

// ---------- step(): the dispatch-and-optimistic-update primitive ----------

test('step in sequential mode dispatches one queued entry per Start', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue();

  assert.deepEqual(q.startIds(), ['q1']);
  assert.deepEqual(q.queuedIds(), ['q2']);
  assert.deepEqual(q.state.started, [started('q1', 'wf1', null)]);
  assert.equal(q.state.running, true);
});

test('full sequential flow: duplicate wf1 entries run one after the other with captured overrides', () => {
  const q = scenario()
    .enqueue('q1', 'wf1', 'claude')
    .enqueue('q2', 'wf1', 'pi')
    .startQueue();
  assert.deepEqual(q.startIds(), ['q1']);
  assert.equal(q.starts[0].harnessOverride, 'claude');

  q.workflowStarted('q1', 'run1');
  assert.deepEqual(q.starts, [], 'q2 must not start while q1 is active');

  q.runFinished('run1');
  assert.deepEqual(q.startIds(), ['q2']);
  assert.equal(q.starts[0].harnessOverride, 'pi');

  q.workflowStarted('q2', 'run2').runFinished('run2');
  assert.deepEqual(q.starts, []);
  assert.equal(q.autoStop, true, 'queue should auto-stop when fully drained');
  assert.equal(q.state.running, false);
  assert.deepEqual(q.state.queued, []);
  assert.deepEqual(q.state.started, []);
});

test('parallel mode dispatches every queued entry at once', () => {
  const q = scenario()
    .setMode('parallel')
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf1')
    .enqueue('q3', 'wf3')
    .startQueue();

  assert.deepEqual(q.startIds(), ['q1', 'q2', 'q3']);
  assert.deepEqual(q.state.queued, []);
  assert.deepEqual(q.startedIds().sort(), ['q1', 'q2', 'q3']);
});

test('parallel mode auto-stops once every dispatch has been confirmed', () => {
  const q = scenario()
    .setMode('parallel')
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue();

  q.workflowStarted('q1', 'run1');
  assert.equal(q.autoStop, false);
  assert.equal(q.state.running, true);

  q.workflowStarted('q2', 'run2');
  assert.equal(q.autoStop, true);
  assert.equal(q.state.running, false);
});

test('parallel mode waits for remaining dispatch confirmations after a dispatch fails', () => {
  const q = scenario()
    .setMode('parallel')
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue();

  q.dispatchFailed('q1');
  assert.deepEqual(q.startedIds(), ['q2']);
  assert.equal(q.autoStop, false);
  assert.equal(q.state.running, true);

  q.workflowStarted('q2', 'run2');
  assert.equal(q.autoStop, true);
  assert.equal(q.state.running, false);
});

test('a failed dispatch in sequential mode skips to the next queued entry', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue();
  assert.deepEqual(q.startIds(), ['q1']);

  q.dispatchFailed('q1');
  assert.deepEqual(q.startIds(), ['q2']);
  assert.deepEqual(q.state.started, [started('q2', 'wf2', null)]);
});

test('stopQueue mid-run prevents further dispatches but leaves the active entry alone', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue()
    .workflowStarted('q1', 'run1')
    .stopQueue();

  assert.equal(q.state.running, false);
  assert.deepEqual(q.state.queued, [queued('q2', 'wf2')]);

  q.runFinished('run1');
  assert.deepEqual(q.starts, []);
  assert.equal(q.state.running, false);
  assert.deepEqual(q.state.started, []);
});

test('workflowStarted twice for the same entry attaches the runId once', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .startQueue()
    .workflowStarted('q1', 'run1');

  const before = q.state;
  q.workflowStarted('q1', 'run-different');
  assert.strictEqual(q.state, before);
  assert.deepEqual(q.state.started, [started('q1', 'wf1', 'run1')]);
});

test('runFinished matches by runId, not duplicate workflow id', () => {
  const state = reduceQueue(
    queueState({
      mode: 'parallel',
      running: true,
      started: [started('q1', 'wf1', 'run1'), started('q2', 'wf1', 'run2')],
    }),
    { type: 'runFinished', runId: 'run2' },
  );

  assert.deepEqual(state.started, [started('q1', 'wf1', 'run1')]);
});

test('shouldAutoStop returns false while items remain or a run is in flight', () => {
  assert.equal(shouldAutoStop(initialQueueState), false);
  assert.equal(
    shouldAutoStop(queueState({ queued: [queued('q1', 'wf1')], running: true })),
    false,
  );
  assert.equal(
    shouldAutoStop(queueState({ running: true, started: [started('q1', 'wf1', 'run1')] })),
    false,
  );
  assert.equal(shouldAutoStop(queueState({ running: true })), true);
});

test('rapid double-Start in sequential mode dispatches the head entry only once', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .startQueue();

  assert.deepEqual(q.startIds(), ['q1']);

  q.startQueue();
  assert.deepEqual(q.starts, [], 'second Start while already running is a no-op');
  assert.equal(q.state.started.length, 1);
});

// ---------- pre-finished runId race ----------
// If WS completed/cancelled arrives before /run HTTP resolves, runFinished is
// dispatched against a started entry whose runId is still null. The scheduler
// must remember the runId so the eventual workflowStarted retires the entry
// instead of attaching a dead id.

test('runFinished before workflowStarted (sequential) lets the next queued workflow start', () => {
  const q = scenario()
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue();
  assert.deepEqual(q.startIds(), ['q1']);

  // WS 'completed' arrives before the /run response — q1 has no runId yet.
  q.runFinished('run1');
  assert.deepEqual(q.starts, [], 'queue must wait for workflowStarted to retire q1');
  assert.equal(q.state.started.length, 1, 'q1 is still in-flight from the scheduler view');
  assert.deepEqual(q.state.preFinishedRunIds, ['run1']);

  // /run finally resolves and we attach the runId — the entry should be
  // retired in the same step and q2 dispatched.
  q.workflowStarted('q1', 'run1');
  assert.deepEqual(q.startIds(), ['q2'], 'q2 starts once the orphan finish is consumed');
  assert.deepEqual(q.state.preFinishedRunIds, [], 'consumed runId is removed');
  assert.equal(q.state.started.length, 1);
  assert.equal(q.state.started[0].id, 'q2');
});

test('runFinished before workflowStarted (parallel) retires the entry and lets autoStop fire', () => {
  const q = scenario()
    .setMode('parallel')
    .enqueue('q1', 'wf1')
    .enqueue('q2', 'wf2')
    .startQueue();
  assert.deepEqual(q.startedIds().sort(), ['q1', 'q2']);

  // q1's run finishes before /run resolves; q2 dispatches normally.
  q.runFinished('run1');
  q.workflowStarted('q2', 'run2');
  assert.equal(q.autoStop, false, 'q1 still pending workflowStarted attachment');

  q.workflowStarted('q1', 'run1');
  assert.equal(q.state.started.length, 1, 'q1 retired by pre-finished consume');
  assert.deepEqual(q.state.preFinishedRunIds, []);

  q.runFinished('run2');
  assert.equal(q.state.started.length, 0);
});

test('pre-finished runId is consumed only by a matching entryId', () => {
  // A manual run completing while the queue is also active leaves an
  // unmatched runId in preFinishedRunIds. The next workflowStarted must NOT
  // consume it unless its runId matches.
  const q = scenario()
    .enqueue('q1', 'wf1')
    .startQueue();

  q.runFinished('manual-run'); // not q1's run
  assert.deepEqual(q.state.preFinishedRunIds, ['manual-run']);

  q.workflowStarted('q1', 'run1');
  assert.equal(q.state.started[0].runId, 'run1', 'q1 attaches normally');
  assert.deepEqual(
    q.state.preFinishedRunIds,
    ['manual-run'],
    'unrelated runId is left for ageing',
  );

  q.runFinished('run1');
  assert.equal(q.state.started.length, 0, 'q1 retires through the normal path');
});

test('duplicate runFinished for the same runId does not double-buffer', () => {
  let state = queueState({
    running: true,
    started: [started('q1', 'wf1', null)],
  });
  state = reduceQueue(state, { type: 'runFinished', runId: 'run1' });
  state = reduceQueue(state, { type: 'runFinished', runId: 'run1' });
  assert.deepEqual(state.preFinishedRunIds, ['run1']);
});

test('preFinishedRunIds is capped to prevent unbounded growth', () => {
  let state = queueState({ running: true });
  for (let i = 0; i < 25; i += 1) {
    state = reduceQueue(state, { type: 'runFinished', runId: `orphan-${i}` });
  }
  assert.equal(state.preFinishedRunIds.length, 16);
  assert.equal(state.preFinishedRunIds[0], 'orphan-9', 'oldest entries drop off the front');
  assert.equal(state.preFinishedRunIds[15], 'orphan-24');
});
