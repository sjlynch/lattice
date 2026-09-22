import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { GraphNode, HealthMetrics } from '../api';

// Regression: HealthTooltip caches its last written position to skip redundant
// transform writes. It renders null for a file without `healthDetails`, so
// hovering one unmounts the tooltip div while the component instance lives on;
// the next health-bearing hover mounts a fresh, hidden div. With the cursor at
// the same clamped spot (anywhere in a viewport corner clamps identically) the
// stale cache matched and the new div was never positioned or revealed.

type Listener = (ev: { clientX: number; clientY: number }) => void;
const g = globalThis as unknown as Record<string, unknown>;
const savedGlobals: Record<string, unknown> = {};
const pointerListeners = new Set<Listener>();
let HealthTooltip: typeof import('../components/forceGraph/HealthTooltip.tsx').HealthTooltip;

before(async () => {
  for (const k of ['React', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals[k] = g[k];
  }
  // The .tsx component is compiled with the classic JSX runtime under tsx.
  g.React = React;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener(type: string, fn: Listener) {
      if (type === 'pointermove') pointerListeners.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      if (type === 'pointermove') pointerListeners.delete(fn);
    },
  };
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  // Imported after the fake window exists: cursorTracker registers its
  // module-level pointermove listener at import time.
  ({ HealthTooltip } = await import('../components/forceGraph/HealthTooltip.tsx'));
});

after(() => {
  for (const [k, v] of Object.entries(savedGlobals)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

const metrics: HealthMetrics = {
  score: 80,
  language: 'typescript',
  loc: 10,
  commentRatio: 0,
  cyclomaticMax: 1,
  cyclomaticTotal: 1,
  cognitiveMax: 0,
  cognitiveTotal: 0,
  maxNestingDepth: 0,
  halstead: { vocabulary: 1, length: 1, volume: 1, difficulty: 1, effort: 1 },
  maintainabilityIndex: 100,
  functionCount: 1,
  namedFunctionCount: 1,
  avgFunctionLength: 1,
  maxFunctionLength: 1,
  maxParamCount: 0,
  classCount: 0,
  callGraphDensity: 0,
  godFunctionRatio: 0,
  smells: [],
  smellCount: 0,
};

function fileNode(id: string, healthDetails?: HealthMetrics): GraphNode {
  return { id, path: id, name: id, kind: 'file', ext: '.ts', healthDetails } as GraphNode;
}

test('a tooltip remounted at the same cursor spot is positioned and revealed', () => {
  // Cursor in the bottom-right corner, so the clamped placement is fixed.
  for (const fn of pointerListeners) fn({ clientX: 990, clientY: 790 });

  const mounted: Array<{ style: Record<string, string> }> = [];
  const createNodeMock = () => {
    const el = { style: {} as Record<string, string>, offsetHeight: 300 };
    mounted.push(el);
    return el;
  };

  let renderer!: ReturnType<typeof TestRenderer.create>;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(HealthTooltip, { node: fileNode('a.ts', metrics) }),
      { createNodeMock },
    );
  });
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].style.visibility, 'visible');

  // A file without health details: the tooltip renders nothing.
  act(() => {
    renderer.update(React.createElement(HealthTooltip, { node: fileNode('b.txt') }));
  });

  act(() => {
    renderer.update(React.createElement(HealthTooltip, { node: fileNode('c.ts', metrics) }));
  });
  assert.equal(mounted.length, 2);
  assert.equal(mounted[1].style.visibility, 'visible');
  assert.equal(mounted[1].style.transform, mounted[0].style.transform);

  act(() => renderer.unmount());
});
