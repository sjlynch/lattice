import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  writeLinkSegments,
  createInstancedLinks,
} from '../components/forceGraph/instancedLinks.ts';

type Vec = { x: number; y: number; z: number };
type Link = { source: Vec; target: Vec };

// Minimal stand-in for the bits of the ForceGraph3D instance the controller
// reads. `graphData().links` is swappable so a test can simulate a full
// graphData() swap (the ghost-merge case) and re-rebuild.
function makeMockGraph(initial: Link[]) {
  const scene = new THREE.Scene();
  let links = initial;
  const graph = {
    scene: () => scene,
    graphData: () => ({ links, nodes: [] }),
    linkVisibility: () => undefined, // → every link visible
    linkColor: () => '#f0f0f0',
    linkOpacity: () => 1,
    linkThreeObject: () => {},
    // node-motion driver sinks (gate.attach subscribes through these)
    onEngineTick: () => {},
    onNodeDrag: () => {},
    onNodeDragEnd: () => {},
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graph: graph as any,
    setLinks: (l: Link[]) => {
      links = l;
    },
    batched: () =>
      scene.children.find(
        (o) => o.userData['lattice:batchedLinks'],
      ) as THREE.LineSegments | undefined,
  };
}

function makeLinks(n: number): Link[] {
  const out: Link[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ source: { x: i, y: 0, z: 0 }, target: { x: i, y: 1, z: 0 } });
  }
  return out;
}

// BUG 1 regression: after a full graphData() swap replaces the link array with
// fresh objects (the git-history ghost merge does this without changing
// `data.links`), the controller must re-capture the new array on rebuild() —
// otherwise syncPositions keeps reading the orphaned pre-swap objects and the
// links freeze at stale positions.
test('rebuild re-captures the link array after a graphData swap', () => {
  const before: Link[] = [
    { source: { x: 1, y: 0, z: 0 }, target: { x: 2, y: 0, z: 0 } },
  ];
  const mock = makeMockGraph(before);
  const ctrl = createInstancedLinks(mock.graph);
  ctrl.setEnabled(true); // first rebuild captures `before`

  const posBefore = mock.batched()!.geometry.getAttribute('position');
  assert.deepEqual([...posBefore.array].slice(0, 6), [1, 0, 0, 2, 0, 0]);

  // Simulate the swap: brand-new link + node objects at new coordinates.
  mock.setLinks([
    { source: { x: 10, y: 0, z: 0 }, target: { x: 20, y: 0, z: 0 } },
  ]);
  ctrl.rebuild();

  const posAfter = mock.batched()!.geometry.getAttribute('position');
  // Reads the post-swap objects, not the orphaned pre-swap ones.
  assert.deepEqual([...posAfter.array].slice(0, 6), [10, 0, 0, 20, 0, 0]);

  ctrl.dispose();
});

// BUG 2 regression: growing the visible link set past the buffer must FREE the
// old position attribute's GPU buffer (via geometry.dispose(), the only route to
// the renderer's gl.deleteBuffer) before swapping in the larger one — otherwise
// the prior buffer leaks on the GPU every growth. With CAPACITY_SLACK, a growth
// reserves headroom so within-capacity rebuilds don't realloc/free at all.
test('growing the link buffer frees the old GPU buffer (geometry.dispose) with slack', () => {
  const mock = makeMockGraph(makeLinks(1));
  const ctrl = createInstancedLinks(mock.graph);
  ctrl.setEnabled(true); // first allocation — no prior attribute, no free

  const geom = mock.batched()!.geometry;
  let disposeCount = 0;
  const realDispose = geom.dispose.bind(geom);
  geom.dispose = () => {
    disposeCount++;
    realDispose();
  };

  const attr0 = geom.getAttribute('position');
  const cap0 = attr0.array.length;
  // Slack means the 1-link buffer already holds many links' worth of floats.
  assert.ok(cap0 >= 1 * 2 * 3, 'buffer at least fits the visible links');

  // Grow well past the slack capacity → must reallocate AND free the old buffer.
  mock.setLinks(makeLinks(400));
  ctrl.rebuild();
  const attr1 = geom.getAttribute('position');
  assert.equal(disposeCount, 1, 'old buffer freed exactly once on growth');
  assert.notEqual(attr1, attr0, 'position attribute replaced on growth');
  assert.ok(attr1.array.length >= 400 * 2 * 3, 'buffer grew to fit');

  // A rebuild that still fits in the (slack-padded) buffer must NOT realloc/free.
  mock.setLinks(makeLinks(420));
  ctrl.rebuild();
  assert.equal(disposeCount, 1, 'no extra free while within capacity (slack)');
  assert.equal(geom.getAttribute('position'), attr1, 'same buffer reused');

  // Restore so the controller's own dispose() doesn't double-count, then tear down.
  geom.dispose = realDispose;
  ctrl.dispose();
});

// A fully-hydrated link writes its two real endpoints, source first.
test('hydrated link writes both endpoints in order', () => {
  const source = { x: 1, y: 2, z: 3 };
  const target = { x: 4, y: 5, z: 6 };
  const out = new Float32Array(6);
  writeLinkSegments([{ source, target }], out);
  assert.deepEqual([...out], [1, 2, 3, 4, 5, 6]);
});

// Regression: a link whose source is still an unhydrated id string must NOT be
// skipped — that left the source vertex at (0,0,0) against the hydrated target,
// rendering a stray line to the world origin. It must collapse to a degenerate
// (both-endpoints-equal) zero-length line at the hydrated endpoint.
test('unhydrated source collapses the segment to a zero-length line, not stale zeros', () => {
  const target = { x: 4, y: 5, z: 6 };
  // Pre-fill with the freshly-grown-buffer state (zeros) the bug rendered from.
  const out = new Float32Array(6); // already all zeros
  writeLinkSegments([{ source: 'src-id', target }], out);
  // Both vertices equal -> zero-length, invisible line.
  assert.deepEqual([...out.slice(0, 3)], [...out.slice(3, 6)], 'both vertices equal');
  // And specifically NOT [0,0,0, 4,5,6] (the stray origin->target line).
  assert.deepEqual([...out], [4, 5, 6, 4, 5, 6]);
});

// Symmetric case: unhydrated target collapses onto the hydrated source.
test('unhydrated target collapses the segment onto the hydrated source', () => {
  const source = { x: 7, y: 8, z: 9 };
  const out = new Float32Array(6);
  out.fill(99); // prove the helper overwrites stale data, never leaves it
  writeLinkSegments([{ source, target: 'tgt-id' }], out);
  assert.deepEqual([...out], [7, 8, 9, 7, 8, 9]);
});

// Neither endpoint hydrated -> degenerate at the origin (still invisible).
test('both endpoints unhydrated collapse to a zero-length line at the origin', () => {
  const out = new Float32Array(6);
  out.fill(99);
  writeLinkSegments([{ source: 'a', target: 'b' }], out);
  assert.deepEqual([...out], [0, 0, 0, 0, 0, 0]);
});

// Missing coords default to 0 (matches the original `?? 0` semantics).
test('missing node coords default to zero', () => {
  const out = new Float32Array(6);
  writeLinkSegments([{ source: {}, target: { x: 1 } }], out);
  assert.deepEqual([...out], [0, 0, 0, 1, 0, 0]);
});

// Multiple links pack consecutively; an unhydrated one in the middle stays
// degenerate without corrupting its neighbours' offsets.
test('writes consecutive links and keeps a mid-list degenerate segment isolated', () => {
  const out = new Float32Array(18);
  writeLinkSegments(
    [
      { source: { x: 0, y: 0, z: 0 }, target: { x: 1, y: 1, z: 1 } },
      { source: 'unhydrated', target: { x: 2, y: 2, z: 2 } },
      { source: { x: 3, y: 3, z: 3 }, target: { x: 4, y: 4, z: 4 } },
    ],
    out,
  );
  assert.deepEqual([...out], [
    0, 0, 0, 1, 1, 1, // first link, normal
    2, 2, 2, 2, 2, 2, // middle link, degenerate at the hydrated target
    3, 3, 3, 4, 4, 4, // last link, normal
  ]);
});
