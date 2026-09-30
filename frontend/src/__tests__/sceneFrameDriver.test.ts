import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachFrameDriver,
  onFrame,
  type FrameCallback,
} from '../components/forceGraph/sceneFrameDriver.ts';

type BeforeRender = (...args: unknown[]) => void;
type DriverState = { callbacks: Set<FrameCallback>; list: FrameCallback[] };

function makeGraph(onBeforeRender: BeforeRender = () => {}) {
  const scene = { onBeforeRender };
  const graph = { scene: () => scene };
  attachFrameDriver(graph);
  return {
    graph,
    scene,
    frame: (...args: unknown[]) => scene.onBeforeRender(...args),
    // Inspect driver ownership directly so release assertions need neither GC
    // nor a later frame (a paused scene may never render again).
    driver: (graph as unknown as { __frameDriver: DriverState }).__frameDriver,
  };
}

test('unsubscribe releases cached callbacks immediately, including the last listener', () => {
  const mock = makeGraph();
  const calls: string[] = [];
  const first = () => { calls.push('first'); };
  const second = () => { calls.push('second'); };
  const offFirst = onFrame(mock.graph, first);
  const offSecond = onFrame(mock.graph, second);
  mock.frame();
  const snapshot = mock.driver.list;
  assert.deepEqual(snapshot, [first, second]);

  offSecond();
  assert.equal(mock.driver.callbacks.has(second), false);
  assert.equal(mock.driver.list.includes(second), false, 'release before another frame');
  assert.notEqual(mock.driver.list, snapshot);
  assert.deepEqual(snapshot, [first, second], 'leave captured snapshots intact');
  offSecond();
  assert.equal(mock.driver.callbacks.size, 1, 'repeated unsubscribe is harmless');

  mock.frame();
  assert.deepEqual(calls, ['first', 'second', 'first']);
  assert.deepEqual(mock.driver.list, [first]);
  offFirst();
  assert.equal(mock.driver.callbacks.size, 0);
  assert.equal(mock.driver.list.length, 0, 'last unsubscribe releases the cache without a frame');
  offFirst();
  assert.equal(mock.driver.list.length, 0);
});

test('membership changes during a frame preserve its snapshot and update the next frame', () => {
  const mock = makeGraph();
  const calls: string[] = [];
  const times: number[] = [];
  const late: FrameCallback = (now) => { calls.push('late'); times.push(now); };
  const second: FrameCallback = (now) => { calls.push('second'); times.push(now); };
  const first: FrameCallback = (now) => {
    calls.push('first');
    times.push(now);
    const snapshot = mock.driver.list;
    offFirst();
    offSecond();
    assert.equal(mock.driver.list.length, 0, 'driver releases even an active snapshot');
    assert.deepEqual(snapshot, [first, second]);
    onFrame(mock.graph, late);
  };
  const offFirst = onFrame(mock.graph, first);
  const offSecond = onFrame(mock.graph, second);

  mock.frame();
  assert.deepEqual(calls, ['first', 'second'], 'removed listeners still finish the current frame');
  assert.equal(times[0], times[1], 'callbacks share the frame timestamp');
  assert.ok(Number.isFinite(times[0]));
  assert.equal(mock.driver.list.includes(first), false);
  assert.equal(mock.driver.list.includes(second), false);

  mock.frame();
  assert.deepEqual(calls, ['first', 'second', 'late']);
  assert.deepEqual(mock.driver.list, [late]);
});

test('adding a frame listener during dispatch leaves the current snapshot unchanged', () => {
  const mock = makeGraph();
  const calls: string[] = [];
  let added = false;
  const late = () => { calls.push('late'); };
  const first = () => {
    calls.push('first');
    if (!added) {
      added = true;
      const snapshot = mock.driver.list;
      onFrame(mock.graph, late);
      assert.deepEqual(snapshot, [first, second]);
    }
  };
  const second = () => { calls.push('second'); };
  onFrame(mock.graph, first);
  onFrame(mock.graph, second);

  mock.frame();
  assert.deepEqual(calls, ['first', 'second']);
  mock.frame();
  assert.deepEqual(calls, ['first', 'second', 'first', 'second', 'late']);
});

test('steady frames reuse the cached array and attachment preserves the previous render hook', () => {
  const calls: string[] = [];
  let previousThis: unknown;
  let previousArgs: unknown[] = [];
  const mock = makeGraph(function (this: unknown, ...args: unknown[]) {
    previousThis = this;
    previousArgs = args;
    calls.push('previous');
  });
  const dispatch = mock.scene.onBeforeRender;
  attachFrameDriver(mock.graph);
  assert.equal(mock.scene.onBeforeRender, dispatch, 'attachment is idempotent');
  const first = () => { calls.push('first'); };
  const second = () => { calls.push('second'); };
  onFrame(mock.graph, first);
  onFrame(mock.graph, second);
  const args = [{ renderer: true }, { camera: true }];

  mock.frame(...args);
  const snapshot = mock.driver.list;
  mock.frame(...args);
  assert.equal(mock.driver.list, snapshot, 'no new callback array for steady frames');
  assert.deepEqual(calls, ['previous', 'first', 'second', 'previous', 'first', 'second']);
  assert.equal(previousThis, mock.scene);
  assert.deepEqual(previousArgs, args);
});

test('null and unattached graphs return harmless frame unsubscriptions', () => {
  const cb = () => { assert.fail('unattached callback must not run'); };
  const graph = { scene: () => { assert.fail('onFrame must not auto-attach'); } };
  const offNull = onFrame(null, cb);
  const offUnattached = onFrame(graph, cb);
  offNull();
  offNull();
  offUnattached();
  offUnattached();
  assert.equal('__frameDriver' in graph, false);
});
