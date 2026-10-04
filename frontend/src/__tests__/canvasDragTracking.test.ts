// Pointer interaction setters clear the force-graph library's picked node.
// A stationary click must preserve that pick; a real drag still suspends raycasts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachCanvasDragTracking } from '../components/forceGraph/hooks/useCanvasDragTracking.ts';

function setup() {
  const container = new EventTarget(), release = new EventTarget();
  const dragging = { current: false }, calls: string[] = [];
  const detach = attachCanvasDragTracking(container, release, dragging,
    () => calls.push('clear'), (on) => calls.push(on ? 'enable' : 'disable'));
  const fire = (type: string, x = 10, pointerId = 1) => {
    const event = Object.assign(new Event(type), { clientX: x, clientY: 10, pointerId });
    (type === 'pointerdown' ? container : release).dispatchEvent(event);
  };
  return { calls, dragging, detach, fire };
}

test('clicks retain the picked node without resetting pointer interaction', () => {
  const s = setup();
  s.fire('pointerdown');
  assert.equal(s.dragging.current, true);
  s.fire('pointermove', 11);
  s.fire('pointerup');
  assert.equal(s.dragging.current, false);
  assert.deepEqual(s.calls, ['clear']);
  s.detach();
});

test('dragging suspends raycasts once, ignores other pointers, and restores on cancellation', () => {
  const s = setup();
  s.fire('pointerdown'); s.fire('pointermove', 20); s.fire('pointermove', 30);
  s.fire('pointerup', 30, 2);
  assert.equal(s.dragging.current, true);
  assert.deepEqual(s.calls, ['clear', 'disable']);
  s.fire('pointercancel');
  assert.equal(s.dragging.current, false);
  assert.deepEqual(s.calls, ['clear', 'disable', 'enable']);
  s.detach();
});

test('unmount releases a suspended drag and removes listeners', () => {
  const s = setup();
  s.fire('pointerdown'); s.fire('pointermove', 30); s.detach();
  assert.equal(s.dragging.current, false);
  assert.deepEqual(s.calls, ['clear', 'disable', 'enable']);
  s.fire('pointerdown'); s.fire('pointermove', 30); s.fire('pointerup');
  assert.deepEqual(s.calls, ['clear', 'disable', 'enable']);
});
