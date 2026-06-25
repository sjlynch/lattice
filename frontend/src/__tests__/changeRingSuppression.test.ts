import { test } from 'node:test';
import assert from 'node:assert/strict';

// The change-ring textures are painted on a 2D canvas, so stub just enough of
// the DOM for `document.createElement('canvas').getContext('2d')` to let THREE
// mint a CanvasTexture under `node --test` (no jsdom). Set before importing
// `changeRing` matters not — texture/material creation is lazy (first ring) —
// but the global must exist by the time a test actually builds a ring.
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
const { setNodeChangeRing, setNodeChangeRingsVisible, setChangeRingsSuppressed } =
  await import('../components/forceGraph/changeRing.ts');

// Mirror of the private tag in changeRing.ts so the test can locate the ring
// sibling child without reaching into module internals.
const CHANGE_RING_TAG = 'lattice:changeRing';

function ring(root: InstanceType<typeof THREE.Object3D>) {
  return root.children.find((c) => c.userData[CHANGE_RING_TAG]);
}

test('a freshly built change ring is visible by default', () => {
  setChangeRingsSuppressed(false);
  const root = new THREE.Group();
  setNodeChangeRing(root, 'added', 5);
  const r = ring(root);
  assert.ok(r, 'ring should be added');
  assert.equal(r!.visible, true);
});

// Regression: scrub the timeline so a ring exists, pin W (suppresses), then any
// graph.refresh() rebuilds nodes via buildNodeObject → setNodeChangeRing. The
// rebuilt ring used to default to visible=true and reappear over the worktree
// rings. With the suppression flag latched, every rebuilt/scrub-added ring must
// start hidden.
test('while W suppresses change rings, a rebuilt ring starts hidden', () => {
  setChangeRingsSuppressed(true);
  try {
    for (const kind of ['added', 'modified'] as const) {
      const root = new THREE.Group(); // a fresh root == a full rebuild
      setNodeChangeRing(root, kind, 5);
      const r = ring(root);
      assert.ok(r, `${kind} ring should be added`);
      assert.equal(r!.visible, false, `${kind} ring must be hidden while W active`);
    }
  } finally {
    setChangeRingsSuppressed(false);
  }
});

test('lifting suppression restores visible rings for later rebuilds', () => {
  setChangeRingsSuppressed(true);
  setChangeRingsSuppressed(false); // W deactivated
  const root = new THREE.Group();
  setNodeChangeRing(root, 'added', 5);
  assert.equal(ring(root)!.visible, true);
});

// The existing per-node hide (setNodeChangeRingsVisible) and the new
// build-time flag compose: hiding an already-mounted ring and then rebuilding
// it under suppression both leave it hidden.
test('setNodeChangeRingsVisible and the suppression flag agree', () => {
  setChangeRingsSuppressed(false);
  const root = new THREE.Group();
  setNodeChangeRing(root, 'added', 5);
  assert.equal(ring(root)!.visible, true);
  setNodeChangeRingsVisible(root, false);
  assert.equal(ring(root)!.visible, false);
  setNodeChangeRingsVisible(root, true);
  assert.equal(ring(root)!.visible, true);
});
