import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Object3D } from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode } from '../api';
import type { NodeObjectRefs } from '../components/forceGraph/nodeObjectFactory.ts';
import { installCanvasDocument } from './domDoubles.ts';

// Node sprites, the worktree ring and the label textures all paint on a 2D
// canvas, so stub `document.createElement('canvas')` before the factory's
// module graph loads (same pattern as changeRingSuppression.test.ts).
installCanvasDocument();

const { buildNodeObject } = await import(
  '../components/forceGraph/nodeObjectFactory.ts'
);
const { applyWorktreeRings, clearWorktreeRings } = await import(
  '../components/forceGraph/worktreeRingSync.ts'
);
const { DEFAULT_SETTINGS } = await import(
  '../components/forceGraph/graphSettings.ts'
);

// Mirror of the private tag in worktreeRing.ts so the test can locate the ring
// sibling child without reaching into module internals.
const RING_TAG = 'lattice:worktree-ring';

function ring(root: Object3D | undefined): Object3D | undefined {
  return root?.children.find((c) => c.userData[RING_TAG]);
}

function makeRefs(): NodeObjectRefs {
  return {
    settingsRef: { current: DEFAULT_SETTINGS },
    selectedRef: { current: new Set<string>() },
    dataRef: { current: null },
    locModeRef: { current: false },
    healthModeRef: { current: false },
    deadModeRef: { current: false },
    labelModeRef: { current: false },
    labelShiftRef: { current: false },
    labelLevelRef: { current: 1 },
    nodeDepthsRef: { current: new Map<string, number>() },
    changeMapRef: { current: new Map() },
    metricsIgnoredExtsRef: { current: new Set<string>() },
    batchedNodesRef: { current: false },
    worktreeRingsRef: { current: null },
  };
}

// The library binds each node's mounted root back onto the sim node under
// `__threeObj` (see mountedNodes.ts); the walkers read it from there.
type MountedNodeLike = GraphNode & { __threeObj?: Object3D };

function fileNode(id: string, path: string): MountedNodeLike {
  return { id, name: path.split('\\').pop() ?? path, path, kind: 'file', ext: '.ts' };
}

function fakeGraph(nodes: MountedNodeLike[]): ForceGraph3DInstance {
  return { graphData: () => ({ nodes }) } as unknown as ForceGraph3DInstance;
}

// Regression: the W ring is the only per-node overlay whose state is not part
// of `decideSpriteState`, so a full sprite rebuild (metric-view toggle, size
// slider, batched-nodes flip, metrics-ignore edit, file-save rescan) used to
// rebuild every root WITHOUT its ring while the view stayed active. The factory
// now re-attaches the ring from the live snapshot ref.
test('buildNodeObject attaches a worktree ring when the live snapshot names the node', () => {
  const refs = makeRefs();
  refs.worktreeRingsRef.current = new Map([['c:/proj/src/a.ts', '#ff0000']]);

  // Backslash + mixed-case path must hit the normalized key.
  const hit = buildNodeObject(fileNode('a', 'C:\\Proj\\src\\a.ts'), refs);
  const r = ring(hit);
  assert.ok(r, 'ring should be attached from the snapshot');
  assert.equal(r!.userData[`${RING_TAG}:color`], '#ff0000');

  const miss = buildNodeObject(fileNode('b', 'C:\\Proj\\src\\b.ts'), refs);
  assert.equal(ring(miss), undefined, 'a path outside the snapshot gets no ring');
});

test('buildNodeObject attaches no ring while the worktree view is inactive', () => {
  const refs = makeRefs(); // worktreeRingsRef.current === null
  const root = buildNodeObject(fileNode('a', 'C:\\proj\\src\\a.ts'), refs);
  assert.equal(ring(root), undefined);
});

test('applyWorktreeRings → full rebuild keeps the rings; clearWorktreeRings strips them all', () => {
  const refs = makeRefs();
  const a = fileNode('a', 'C:\\proj\\a.ts');
  const b = fileNode('b', 'C:\\proj\\b.ts');
  const nodes = [a, b];
  // Initial mount: the view is inactive, so no root carries a ring.
  for (const n of nodes) n.__threeObj = buildNodeObject(n, refs);
  const graph = fakeGraph(nodes);

  applyWorktreeRings(
    graph,
    refs.worktreeRingsRef,
    new Map([['c:/proj/a.ts', '#00ff00']]),
    DEFAULT_SETTINGS,
  );
  assert.ok(ring(a.__threeObj), 'a ringed in place by the walker');
  assert.equal(ring(b.__threeObj), undefined, 'b untouched');

  // What graph.refresh() does per node: a brand-new root via nodeThreeObject.
  for (const n of nodes) n.__threeObj = buildNodeObject(n, refs);
  const rebuilt = ring(a.__threeObj);
  assert.ok(rebuilt, 'the rebuilt root must still carry the ring');
  assert.equal(rebuilt!.userData[`${RING_TAG}:color`], '#00ff00');
  assert.equal(ring(b.__threeObj), undefined);

  // A later snapshot that drops `a` and adds `b` strips/rings accordingly.
  applyWorktreeRings(
    graph,
    refs.worktreeRingsRef,
    new Map([['c:/proj/b.ts', '#0000ff']]),
    DEFAULT_SETTINGS,
  );
  assert.equal(ring(a.__threeObj), undefined, 'a stripped when it leaves the snapshot');
  assert.ok(ring(b.__threeObj), 'b ringed when it enters the snapshot');

  // Deactivate: every ring goes, the snapshot is dropped, and a rebuild after
  // that stays ring-free.
  clearWorktreeRings(graph, refs.worktreeRingsRef);
  assert.equal(refs.worktreeRingsRef.current, null);
  assert.equal(ring(a.__threeObj), undefined);
  assert.equal(ring(b.__threeObj), undefined);
  for (const n of nodes) n.__threeObj = buildNodeObject(n, refs);
  assert.equal(ring(b.__threeObj), undefined, 'no ring rebuilt once the view is off');
});

test('clearWorktreeRings strips rings the walker never applied (a ring minted by a rebuild)', () => {
  const refs = makeRefs();
  refs.worktreeRingsRef.current = new Map([['c:/proj/a.ts', '#ff00ff']]);
  const a = fileNode('a', 'C:\\proj\\a.ts');
  // Ringed by the factory alone — the old id-set bookkeeping never saw this.
  a.__threeObj = buildNodeObject(a, refs);
  assert.ok(ring(a.__threeObj));

  clearWorktreeRings(fakeGraph([a]), refs.worktreeRingsRef);
  assert.equal(ring(a.__threeObj), undefined, 'scene walk strips any tagged ring');
  assert.equal(refs.worktreeRingsRef.current, null);
});
