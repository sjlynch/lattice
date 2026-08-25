import { test } from 'node:test';
import assert from 'node:assert/strict';

// Change-ring textures are painted on a 2D canvas, so stub just enough of the
// DOM for `document.createElement('canvas').getContext('2d')` to let THREE mint
// a CanvasTexture under `node --test` (no jsdom). Mirrors changeRingSuppression.
const makeCtx = () => ({
  createRadialGradient: () => ({ addColorStop: () => {} }),
  fillRect: () => {},
  beginPath: () => {},
  arc: () => {},
  stroke: () => {},
  fill: () => {},
});
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) =>
    tag === 'canvas'
      ? { width: 0, height: 0, getContext: () => makeCtx() }
      : {},
};

const THREE = await import('three');
const { computeChangeMap } = await import('../components/forceGraph/timelineDiff.ts');
const { applyChangeRingDelta } = await import('../components/forceGraph/changeRingSync.ts');
const { resetChangeRingsForProjectSwitch } = await import(
  '../components/forceGraph/timelineReset.ts'
);
const { prepareGhostMerge } = await import(
  '../components/forceGraph/hooks/graphDataSyncCore.ts'
);

// Mirror of the private tag in changeRing.ts so we can locate the ring sibling
// child without reaching into module internals.
const CHANGE_RING_TAG = 'lattice:changeRing';
function ring(root: InstanceType<typeof THREE.Object3D>) {
  return root.children.find((c) => c.userData[CHANGE_RING_TAG]);
}

// applyChangeRingDelta only reads `settings.fileNodeSize`.
const SETTINGS = { fileNodeSize: 5 } as unknown as Parameters<
  typeof applyChangeRingDelta
>[3];

type StubNode = {
  id: string;
  path: string;
  kind: 'file';
  __threeObj: InstanceType<typeof THREE.Group>;
};
function fileNode(id: string, path: string): StubNode {
  return { id, path, kind: 'file', __threeObj: new THREE.Group() };
}

// The regression: mount with project A's history (package.json modified), then
// switch the active folder to project B *before* B's git fetch resolves. The
// previous project's change rings must be stripped and the change map emptied,
// so a structural rebuild of B's graph (which reads `changeMapRef` live) can't
// paint A's "modified" ring onto B's own package.json.
test('a project switch strips the previous project\'s change rings and empties the map', () => {
  const rootA = 'C:/projA';
  const pkg = fileNode('a:pkg', 'C:/projA/package.json');
  const readme = fileNode('a:readme', 'C:/projA/README.md');
  const graph = { graphData: () => ({ nodes: [pkg, readme] }) } as unknown as Parameters<
    typeof applyChangeRingDelta
  >[0];

  // Project A: package.json modified in the working tree → its change ring.
  const aHistory = {
    isRepo: true as const,
    commits: [],
    uncommitted: { changes: [{ path: 'package.json', status: 'M' as const }] },
  };
  const aMap = computeChangeMap(aHistory.commits, aHistory.uncommitted, 0, 0);
  const changeMapRef = { current: new Map<string, 'added' | 'modified' | 'deleted'>() };
  applyChangeRingDelta(graph, changeMapRef.current, aMap, SETTINGS, rootA);
  changeMapRef.current = aMap;
  assert.ok(ring(pkg.__threeObj), 'package.json should carry A\'s change ring before the switch');
  assert.equal(ring(readme.__threeObj), undefined, 'README has no change');

  // --- switch active folder A→B, before B's git history resolves ---
  const touched = resetChangeRingsForProjectSwitch(graph, changeMapRef, SETTINGS, rootA);

  assert.equal(touched, true, 'the switch should have touched a mounted ring');
  assert.equal(changeMapRef.current.size, 0, 'the change map must be emptied on switch');
  assert.equal(
    ring(pkg.__threeObj),
    undefined,
    'no node may carry a change ring after the switch (until B\'s history loads)',
  );
});

// With the previous project's history cleared to null, `prepareGhostMerge` must
// build no ghost nodes for the new project — so A's deleted-file ghosts never
// appear in B's graph during the async window.
test('a project switch (history null) injects no ghosts into the new project', () => {
  const bData = {
    root: 'C:/projB',
    nodes: [
      { id: 'b:pkg', name: 'package.json', path: 'C:/projB/package.json', kind: 'file' as const, ext: '.json' },
    ],
    links: [],
  } as unknown as Parameters<typeof prepareGhostMerge>[0];

  const merged = prepareGhostMerge(bData, null);
  assert.equal(merged.ghostIds.size, 0, 'no ghosts with history === null');
  assert.equal(merged.mergedNodes.length, 1, 'B keeps exactly its own nodes');

  // Contrast: had A's history leaked through, a file that A deleted (and isn't
  // in B's scan) would be injected as a ghost disc into B's graph — exactly the
  // stale-ghost bug the null-history reset prevents.
  const aHistory = {
    isRepo: true as const,
    commits: [],
    uncommitted: { changes: [{ path: 'a-only-deleted.ts', status: 'D' as const }] },
    deletedPaths: ['a-only-deleted.ts'],
  } as unknown as Parameters<typeof prepareGhostMerge>[1];
  const leaked = prepareGhostMerge(bData, aHistory);
  assert.ok(
    leaked.ghostIds.size > 0,
    'sanity: A\'s history WOULD have injected a ghost into B (which the reset avoids)',
  );
});
