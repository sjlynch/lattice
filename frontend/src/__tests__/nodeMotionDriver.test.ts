import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachNodeMotionDriver,
  onNodeDragMove,
  onNodeMotion,
  type DragListener,
} from '../components/forceGraph/nodeMotionDriver.ts';

type MotionListener = () => void;
type DragCallback = (node: unknown, translate: unknown) => void;
type DriverState = {
  listeners: Set<MotionListener>;
  list: MotionListener[];
  dragListeners: Set<DragListener>;
  dragList: DragListener[];
};

function makeGraph() {
  const slots: { tick: MotionListener; drag: DragCallback; dragEnd: DragCallback } = {
    tick: () => {}, drag: () => {}, dragEnd: () => {},
  };
  const installations = { tick: 0, drag: 0, dragEnd: 0 };
  const graph = {
    onEngineTick: (fn: MotionListener) => { slots.tick = fn; installations.tick++; },
    onNodeDrag: (fn: DragCallback) => { slots.drag = fn; installations.drag++; },
    onNodeDragEnd: (fn: DragCallback) => { slots.dragEnd = fn; installations.dragEnd++; },
  };
  return {
    graph,
    slots,
    installations,
    // Read the stamped state after auto-attachment to assert reference release
    // without requiring GC or a subsequent motion/drag event.
    driver: () => (graph as unknown as { __nodeMotionDriver: DriverState }).__nodeMotionDriver,
  };
}

test('motion unsubscribe releases cached callbacks immediately, including the last listener', () => {
  const mock = makeGraph();
  const calls: string[] = [];
  const first = () => { calls.push('first'); };
  const second = () => { calls.push('second'); };
  const offFirst = onNodeMotion(mock.graph, first);
  const offSecond = onNodeMotion(mock.graph, second);
  mock.slots.tick();
  const driver = mock.driver();
  const snapshot = driver.list;
  assert.deepEqual(snapshot, [first, second]);

  offSecond();
  assert.equal(driver.listeners.has(second), false);
  assert.equal(driver.list.includes(second), false, 'release without another event');
  assert.notEqual(driver.list, snapshot);
  assert.deepEqual(snapshot, [first, second], 'leave captured snapshots intact');
  offSecond();
  assert.equal(driver.listeners.size, 1);

  mock.slots.tick();
  assert.deepEqual(calls, ['first', 'second', 'first']);
  assert.deepEqual(driver.list, [first]);
  offFirst();
  assert.equal(driver.listeners.size, 0);
  assert.equal(driver.list.length, 0, 'last unsubscribe releases the cache without a tick');
  offFirst();
  assert.equal(driver.list.length, 0);
});

test('drag unsubscribe releases cached callbacks immediately, including the last listener', () => {
  const mock = makeGraph();
  const calls: string[] = [];
  const first = () => { calls.push('first'); };
  const second = () => { calls.push('second'); };
  const offFirst = onNodeDragMove(mock.graph, first);
  const offSecond = onNodeDragMove(mock.graph, second);
  mock.slots.drag({}, {});
  const driver = mock.driver();
  const snapshot = driver.dragList;
  assert.deepEqual(snapshot, [first, second]);

  offSecond();
  assert.equal(driver.dragListeners.has(second), false);
  assert.equal(driver.dragList.includes(second), false, 'release without another drag');
  assert.notEqual(driver.dragList, snapshot);
  assert.deepEqual(snapshot, [first, second], 'leave captured snapshots intact');
  offSecond();
  assert.equal(driver.dragListeners.size, 1);

  mock.slots.dragEnd({}, {});
  assert.deepEqual(calls, ['first', 'second', 'first']);
  assert.deepEqual(driver.dragList, [first]);
  offFirst();
  assert.equal(driver.dragListeners.size, 0);
  assert.equal(driver.dragList.length, 0, 'last unsubscribe releases the cache without a drag');
  offFirst();
  assert.equal(driver.dragList.length, 0);
});

test('motion membership changes preserve the in-flight snapshot and update the next tick', () => {
  const mock = makeGraph();
  const calls: string[] = [];
  const late = () => { calls.push('late'); };
  const second = () => { calls.push('second'); };
  const first = () => {
    calls.push('first');
    const driver = mock.driver();
    const snapshot = driver.list;
    offFirst();
    offSecond();
    assert.equal(driver.list.length, 0, 'driver releases even an active snapshot');
    assert.deepEqual(snapshot, [first, second]);
    onNodeMotion(mock.graph, late);
  };
  const offFirst = onNodeMotion(mock.graph, first);
  const offSecond = onNodeMotion(mock.graph, second);

  mock.slots.tick();
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(mock.driver().list.includes(first), false);
  assert.equal(mock.driver().list.includes(second), false);
  mock.slots.tick();
  assert.deepEqual(calls, ['first', 'second', 'late']);
  assert.deepEqual(mock.driver().list, [late]);
});

for (const event of ['drag', 'dragEnd'] as const) {
  test(`${event} membership changes preserve the in-flight snapshot and update the next drag`, () => {
    const mock = makeGraph();
    const calls: string[] = [];
    const node = { x: 1 };
    const translate = { x: 2, y: 0, z: 0 };
    const late: DragListener = () => { calls.push('late'); };
    const second: DragListener = (receivedNode, receivedTranslate, isEnd) => {
      assert.equal(receivedNode, node);
      assert.equal(receivedTranslate, translate);
      assert.equal(isEnd, event === 'dragEnd');
      calls.push('second');
    };
    const first: DragListener = () => {
      calls.push('first');
      const driver = mock.driver();
      const snapshot = driver.dragList;
      offFirst();
      offSecond();
      assert.equal(driver.dragList.length, 0, 'driver releases even an active snapshot');
      assert.deepEqual(snapshot, [first, second]);
      onNodeDragMove(mock.graph, late);
    };
    const offFirst = onNodeDragMove(mock.graph, first);
    const offSecond = onNodeDragMove(mock.graph, second);
    onNodeMotion(mock.graph, () => { calls.push('motion'); });

    mock.slots[event](node, translate);
    assert.deepEqual(calls, ['first', 'second', 'motion']);
    assert.equal(mock.driver().dragList.includes(first), false);
    assert.equal(mock.driver().dragList.includes(second), false);
    mock.slots[event](node, translate);
    assert.deepEqual(calls, ['first', 'second', 'motion', 'late', 'motion']);
    assert.deepEqual(mock.driver().dragList, [late]);
  });
}

for (const event of ['tick', 'drag', 'dragEnd'] as const) {
  test(`adding a listener during ${event} leaves the current snapshot unchanged`, () => {
    const mock = makeGraph();
    const calls: string[] = [];
    const subscribe = (cb: MotionListener) => event === 'tick'
      ? onNodeMotion(mock.graph, cb) : onNodeDragMove(mock.graph, cb);
    const dispatch = () => event === 'tick' ? mock.slots.tick() : mock.slots[event]({}, {});
    let added = false;
    const late = () => { calls.push('late'); };
    const first = () => {
      calls.push('first');
      if (!added) {
        added = true;
        const driver = mock.driver();
        const snapshot = event === 'tick' ? driver.list : driver.dragList;
        subscribe(late);
        assert.deepEqual(snapshot, [first, second]);
      }
    };
    const second = () => { calls.push('second'); };
    subscribe(first);
    subscribe(second);

    dispatch();
    assert.deepEqual(calls, ['first', 'second']);
    dispatch();
    assert.deepEqual(calls, ['first', 'second', 'first', 'second', 'late']);
  });
}

test('steady events reuse both caches and drag listeners run before motion with unchanged arguments', () => {
  const mock = makeGraph();
  const calls: string[] = [];
  const node = { x: 0 };
  const translate = { x: 1, y: 0, z: 0 };
  const endings: boolean[] = [];
  const offDrag = onNodeDragMove(mock.graph, (receivedNode, receivedTranslate, isEnd) => {
    assert.equal(receivedNode, node);
    assert.equal(receivedTranslate, translate);
    endings.push(isEnd);
    node.x++;
    calls.push('drag');
  });
  const offMotion = onNodeMotion(mock.graph, () => {
    assert.equal(node.x, endings.length, 'motion sees the drag mutation');
    calls.push('motion');
  });
  const installed = { ...mock.slots };
  attachNodeMotionDriver(mock.graph);
  mock.slots.drag(node, translate);
  const driver = mock.driver();
  const motionSnapshot = driver.list;
  const dragSnapshot = driver.dragList;
  mock.slots.drag(node, translate);
  mock.slots.dragEnd(node, translate);
  mock.slots.tick();
  assert.equal(driver.list, motionSnapshot);
  assert.equal(driver.dragList, dragSnapshot, 'drag move/end reuse the same cache');
  assert.deepEqual(endings, [false, false, true]);
  assert.deepEqual(calls, ['drag', 'motion', 'drag', 'motion', 'drag', 'motion', 'motion']);

  offDrag();
  offMotion();
  offDrag();
  offMotion();
  attachNodeMotionDriver(mock.graph);
  assert.deepEqual(mock.installations, { tick: 1, drag: 1, dragEnd: 1 });
  assert.equal(mock.slots.tick, installed.tick);
  assert.equal(mock.slots.drag, installed.drag);
  assert.equal(mock.slots.dragEnd, installed.dragEnd);
  mock.slots.tick();
  mock.slots.drag(node, translate);
  mock.slots.dragEnd(node, translate);
  assert.equal(calls.length, 7, 'permanent dispatchers remain callable with no listeners');
});

test('null graphs return harmless motion and drag unsubscriptions', () => {
  const cb = () => { assert.fail('null-graph callback must not run'); };
  const offMotion = onNodeMotion(null, cb);
  const offDrag = onNodeDragMove(null, cb);
  offMotion();
  offDrag();
  offMotion();
  offDrag();
});
