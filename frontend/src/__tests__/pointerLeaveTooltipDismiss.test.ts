import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachPointerLeaveTooltipDismiss } from '../components/forceGraph/hooks/usePointerLeaveTooltipDismiss.ts';

// Regression: a graph node tooltip stayed open (the React HealthTooltip trailing
// the cursor, or the library's native label parked over the canvas) after the
// cursor left the graph for the navbar / terminal panel, because 3d-force-graph
// keeps raycasting its last on-canvas pointer position. Leaving the canvas must
// clear the tooltip and suspend the library's hover; re-entering restores it.

function setup(dragging = false) {
  const container = new EventTarget();
  const pointerOutsideRef = { current: false };
  const pointerDraggingRef = { current: dragging };
  const calls: string[] = [];
  const detach = attachPointerLeaveTooltipDismiss(container, {
    pointerOutsideRef,
    pointerDraggingRef,
    clearHoverTooltip: () => calls.push('clear'),
    setPointerInteraction: (on) => calls.push(on ? 'enable' : 'disable'),
  });
  const fire = (type: string) => container.dispatchEvent(new Event(type));
  return { container, pointerOutsideRef, pointerDraggingRef, calls, detach, fire };
}

test('leaving the canvas clears the tooltip and suspends library hover', () => {
  const { pointerOutsideRef, calls, fire } = setup();
  fire('pointerleave');
  assert.equal(pointerOutsideRef.current, true);
  assert.deepEqual(calls, ['clear', 'disable']);
});

test('re-entering the canvas re-enables library hover', () => {
  const { pointerOutsideRef, calls, fire } = setup();
  fire('pointerleave');
  fire('pointerenter');
  assert.equal(pointerOutsideRef.current, false);
  assert.deepEqual(calls, ['clear', 'disable', 'enable']);
});

test('an enter without a prior leave is a no-op', () => {
  const { calls, fire } = setup();
  fire('pointerenter');
  assert.deepEqual(calls, []);
});

test('mid-drag, pointer interaction is left to the drag tracker', () => {
  const { pointerOutsideRef, pointerDraggingRef, calls, fire } = setup(true);
  fire('pointerleave');
  assert.equal(pointerOutsideRef.current, true);
  assert.deepEqual(calls, ['clear']);
  pointerDraggingRef.current = false;
  fire('pointerenter');
  assert.deepEqual(calls, ['clear', 'enable']);
});

test('detaching while outside restores interaction and stops listening', () => {
  const { pointerOutsideRef, calls, fire, detach } = setup();
  fire('pointerleave');
  detach();
  assert.equal(pointerOutsideRef.current, false);
  assert.deepEqual(calls, ['clear', 'disable', 'enable']);
  fire('pointerleave');
  assert.deepEqual(calls, ['clear', 'disable', 'enable']);
});
