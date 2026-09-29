import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { createResizeObserver } from '../components/forceGraph/sceneSetup.ts';
import {
  attachIdleController,
  type IdleController,
} from '../components/forceGraph/idleController.ts';

// Regression: resizing the canvas (a sidebar drag) clears its drawing buffer,
// and the library's resize path doesn't render. With the render loop paused on
// a settled scene the graph stayed blank until the cursor next crossed it, so
// the resize must wake the idle controller for a short frame tail.

test('a container resize applies the new size and wakes the render loop', async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const savedRO = g.ResizeObserver;
  let fire: (() => void) | null = null;
  g.ResizeObserver = class {
    constructor(cb: () => void) {
      fire = cb;
    }
    observe() {}
    disconnect() {}
  };
  try {
    const sizes: Array<[string, number]> = [];
    const graph = {
      width: (w: number) => sizes.push(['w', w]),
      height: (h: number) => sizes.push(['h', h]),
    } as unknown as ForceGraph3DInstance;
    let wakes = 0;
    attachIdleController(graph, {
      wakeForRefresh: () => {
        wakes++;
      },
    } as unknown as IdleController);
    const container = { clientWidth: 800, clientHeight: 600 } as HTMLDivElement;

    const teardown = createResizeObserver(graph, container);
    assert.deepEqual(sizes, [['w', 800], ['h', 600]]);
    const wakesAfterInit = wakes;

    // Simulate a sidebar drag narrowing the graph container.
    (container as { clientWidth: number }).clientWidth = 640;
    fire!();
    await new Promise((r) => setTimeout(r, 200)); // past the resize debounce
    assert.deepEqual(sizes.slice(2), [['w', 640], ['h', 600]]);
    assert.equal(wakes, wakesAfterInit + 1);
    teardown();
  } finally {
    if (savedRO === undefined) delete g.ResizeObserver;
    else g.ResizeObserver = savedRO;
  }
});

// A full-width terminal sidebar hides the graph (`display: none`), collapsing
// its container to 0×0. Sizing the camera to that would give it a NaN aspect,
// so the collapse is ignored and the last real size kept until it's shown.
test('a collapsed (0×0) container keeps the last real size', async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const savedRO = g.ResizeObserver;
  let fire: (() => void) | null = null;
  g.ResizeObserver = class {
    constructor(cb: () => void) {
      fire = cb;
    }
    observe() {}
    disconnect() {}
  };
  try {
    const sizes: Array<[string, number]> = [];
    const graph = {
      width: (w: number) => sizes.push(['w', w]),
      height: (h: number) => sizes.push(['h', h]),
    } as unknown as ForceGraph3DInstance;
    const container = { clientWidth: 800, clientHeight: 600 } as HTMLDivElement;
    const teardown = createResizeObserver(graph, container);

    Object.assign(container, { clientWidth: 0, clientHeight: 0 });
    fire!();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(sizes, [['w', 800], ['h', 600]]);

    Object.assign(container, { clientWidth: 900, clientHeight: 600 });
    fire!();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(sizes.slice(2), [['w', 900], ['h', 600]]);
    teardown();
  } finally {
    if (savedRO === undefined) delete g.ResizeObserver;
    else g.ResizeObserver = savedRO;
  }
});
