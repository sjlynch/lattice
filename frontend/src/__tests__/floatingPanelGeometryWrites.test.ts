import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pos, Size } from '../components/floatingPanel/geometry.ts';
import { createGeometryWriteQueue } from '../components/floatingPanel/usePanelGeometry.ts';

// FloatingPanel persistence is coalesced to at most one localStorage write per
// key per animation frame (drag/resize change pos/size on every mousemove), and
// the stored result must equal what a write per change would have left.

function harness() {
  const writes: Array<{ storageKey: string; pos: Pos; size: Size }> = [];
  const frames = new Map<number, () => void>();
  let nextHandle = 1;
  const queue = createGeometryWriteQueue(
    (storageKey, pos, size) => writes.push({ storageKey, pos, size }),
    {
      request: (callback) => {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      cancel: (handle) => {
        frames.delete(handle);
      },
    },
  );
  const runFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback();
  };
  return { queue, writes, frames, runFrame };
}

const size = { width: 400, height: 300 };

test('many changes within a frame land as one write of the latest geometry', () => {
  const { queue, writes, frames, runFrame } = harness();
  for (let x = 0; x < 20; x += 1) queue.schedule('lattice.k.window', { x, y: 5 }, size);
  assert.equal(writes.length, 0);
  assert.equal(frames.size, 1);

  runFrame();
  assert.deepEqual(writes, [{ storageKey: 'lattice.k.window', pos: { x: 19, y: 5 }, size }]);

  // Nothing queued: the next frame writes nothing and none is requested.
  runFrame();
  assert.equal(writes.length, 1);
  assert.equal(frames.size, 0);
});

test('each key keeps its own latest geometry', () => {
  const { queue, writes, runFrame } = harness();
  queue.schedule('a', { x: 1, y: 1 }, size);
  queue.schedule('b', { x: 2, y: 2 }, size);
  queue.schedule('a', { x: 3, y: 3 }, size);
  runFrame();
  assert.deepEqual(
    writes.map((w) => [w.storageKey, w.pos]),
    [
      ['a', { x: 3, y: 3 }],
      ['b', { x: 2, y: 2 }],
    ],
  );
});

test('flush writes immediately and cancels the pending frame', () => {
  const { queue, writes, frames, runFrame } = harness();
  queue.schedule('k', { x: 7, y: 8 }, size);
  queue.flush();
  assert.deepEqual(writes, [{ storageKey: 'k', pos: { x: 7, y: 8 }, size }]);
  assert.equal(frames.size, 0);

  runFrame();
  queue.flush();
  assert.equal(writes.length, 1);

  // A change after a flush schedules a fresh frame.
  queue.schedule('k', { x: 9, y: 9 }, size);
  assert.equal(frames.size, 1);
  runFrame();
  assert.deepEqual(writes[1], { storageKey: 'k', pos: { x: 9, y: 9 }, size });
});

test('a panel without a storage key never queues a write or a frame', () => {
  const { queue, writes, frames } = harness();
  queue.schedule(undefined, { x: 1, y: 1 }, size);
  queue.schedule('', { x: 1, y: 1 }, size);
  assert.equal(frames.size, 0);
  queue.flush();
  assert.equal(writes.length, 0);
});
