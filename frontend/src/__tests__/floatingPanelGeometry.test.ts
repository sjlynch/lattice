import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPos, VIEWPORT_PAD } from '../components/floatingPanel/geometry.ts';

function withViewport<T>(width: number, height: number, fn: () => T): T {
  const prev = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { innerWidth: width, innerHeight: height };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = prev;
  }
}

test('clampPos keeps a fitting panel within its bounds', () => {
  withViewport(1000, 800, () => {
    // In-bounds position is preserved.
    assert.deepEqual(clampPos({ x: 100, y: 60 }, { width: 400, height: 300 }), {
      x: 100,
      y: 60,
    });
    // Beyond the right/bottom edge clamps to the floored max.
    assert.deepEqual(clampPos({ x: 5000, y: 5000 }, { width: 400, height: 300 }), {
      x: 1000 - 400 - VIEWPORT_PAD,
      y: 800 - 300 - VIEWPORT_PAD,
    });
    // Negative input clamps up to the padding.
    assert.deepEqual(clampPos({ x: -50, y: -50 }, { width: 400, height: 300 }), {
      x: VIEWPORT_PAD,
      y: VIEWPORT_PAD,
    });
  });
});

test('clampPos keeps the header reachable when the panel is larger than the viewport', () => {
  withViewport(500, 400, () => {
    // Panel wider and taller than the window: max bound would be negative, but
    // the floor keeps the panel at the top-left padding rather than off-screen.
    const clamped = clampPos({ x: 200, y: 150 }, { width: 800, height: 700 });
    assert.deepEqual(clamped, { x: VIEWPORT_PAD, y: VIEWPORT_PAD });
    assert.ok(clamped.x >= VIEWPORT_PAD);
    assert.ok(clamped.y >= VIEWPORT_PAD);

    // Even an already-negative persisted position is pulled back on-screen.
    const recovered = clampPos({ x: -300, y: -300 }, { width: 800, height: 700 });
    assert.ok(recovered.x >= VIEWPORT_PAD);
    assert.ok(recovered.y >= VIEWPORT_PAD);
  });
});
