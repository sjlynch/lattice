import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { useGraphSearchNavigation } from '../components/forceGraph/hooks/useGraphSearchNavigation.ts';

// Regression: the camera follow keyed only on the current match id, so a step
// that landed on the same id (a one-match search, or wrapping back onto the
// current match) never re-centered — after orbiting away, "next" did nothing.

const g = globalThis as unknown as Record<string, unknown>;
let saved: unknown;

beforeEach(() => {
  saved = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (saved === undefined) delete g.IS_REACT_ACT_ENVIRONMENT;
  else g.IS_REACT_ACT_ENVIRONMENT = saved;
});

function fakeGraph(focusCalls: string[]) {
  const nodes = [
    { id: 'a', x: 1, y: 2, z: 3 },
    { id: 'b', x: 4, y: 5, z: 6 },
  ];
  return {
    graphData: () => ({ nodes }),
    camera: () => ({ position: { x: 0, y: 0, z: 100 } }),
    controls: () => ({ target: { x: 0, y: 0, z: 0 } }),
    cameraPosition: (_pos: unknown, lookAt: { x: number }) => {
      focusCalls.push(nodes.find((n) => n.x === lookAt.x)!.id);
    },
  } as unknown as ForceGraph3DInstance;
}

function mount(matches: string[]) {
  const focusCalls: string[] = [];
  const graphRef = { current: fakeGraph(focusCalls) };
  let api!: ReturnType<typeof useGraphSearchNavigation>;
  function Harness() {
    api = useGraphSearchNavigation({ graphRef, searchMatches: matches });
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });
  return { focusCalls, api: () => api, renderer };
}

test('stepping onto the same single match re-focuses the camera each time', () => {
  const { focusCalls, api, renderer } = mount(['a']);
  act(() => api().goNextMatch());
  act(() => api().goNextMatch());
  act(() => api().goPrevMatch());
  assert.deepEqual(focusCalls, ['a', 'a', 'a']);
  assert.equal(api().searchMatchPosition, 1);
  act(() => renderer.unmount());
});

test('stepping across matches focuses each in turn; clearing does not focus', () => {
  const { focusCalls, api, renderer } = mount(['a', 'b']);
  act(() => api().goNextMatch());
  act(() => api().goNextMatch());
  act(() => api().clearCurrentMatch());
  assert.deepEqual(focusCalls, ['a', 'b']);
  assert.equal(api().searchMatchPosition, 0);
  act(() => renderer.unmount());
});
