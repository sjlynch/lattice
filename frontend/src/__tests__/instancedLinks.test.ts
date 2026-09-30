import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  writeLinkSegments,
  createInstancedLinks,
  getInstancedLinks,
} from '../components/forceGraph/instancedLinks.ts';

type Vec = { x: number; y: number; z: number };
type Link = { source: Vec | string; target: Vec | string };

// Minimal stand-in for the bits of the ForceGraph3D instance the controller
// reads. `graphData().links` is swappable so a test can simulate a full
// graphData() swap (the ghost-merge case) and re-rebuild.
function makeMockGraph(initial: Link[]) {
  const scene = new THREE.Scene();
  let links = initial;
  let visibility: unknown = undefined; // → every link visible
  const linkThreeObjectCalls: unknown[] = [];
  const graph = {
    scene: () => scene,
    graphData: () => ({ links, nodes: [] }),
    linkVisibility: () => visibility,
    linkColor: () => '#f0f0f0',
    linkOpacity: () => 1,
    linkThreeObject: (value: unknown) => { linkThreeObjectCalls.push(value); },
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
    setLinkVisibility: (value: unknown) => { visibility = value; },
    linkThreeObjectCalls,
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

test('disabling releases owned resources once and keeps the controller until final dispose', () => {
  const mock = makeMockGraph(makeLinks(1));
  const ctrl = createInstancedLinks(mock.graph);
  ctrl.setEnabled(true);

  const batch = mock.batched()!;
  const material = batch.material as THREE.LineBasicMaterial;
  let geometryDisposes = 0;
  let materialDisposes = 0;
  batch.geometry.addEventListener('dispose', () => { geometryDisposes++; });
  material.addEventListener('dispose', () => { materialDisposes++; });

  ctrl.setEnabled(false);
  assert.equal(mock.batched(), undefined, 'inactive batch removed from the scene');
  assert.equal(batch.parent, null);
  assert.equal(geometryDisposes, 1);
  assert.equal(materialDisposes, 1);
  assert.equal(mock.linkThreeObjectCalls[1], null, 'per-link rendering restored');
  assert.equal(getInstancedLinks(mock.graph), ctrl, 'temporary disable keeps the stamp');

  ctrl.setEnabled(false);
  ctrl.rebuild();
  ctrl.onFrame();
  assert.equal(mock.batched(), undefined, 'disabled hooks do not recreate the batch');
  assert.equal(mock.linkThreeObjectCalls.length, 2, 'repeated disable is a no-op');
  ctrl.dispose();
  ctrl.dispose();
  assert.equal(geometryDisposes, 1, 'final disposal does not free geometry again');
  assert.equal(materialDisposes, 1, 'final disposal does not free material again');
  assert.equal(getInstancedLinks(mock.graph), null, 'final dispose clears the stamp');
});

test('re-enabling recreates resources from current links and preserves buffer growth slack', () => {
  const mock = makeMockGraph(makeLinks(1));
  const ctrl = createInstancedLinks(mock.graph);
  ctrl.setEnabled(true);
  const oldBatch = mock.batched()!;
  const oldAttribute = oldBatch.geometry.getAttribute('position');
  const oldMaterial = oldBatch.material as THREE.LineBasicMaterial;
  ctrl.setEnabled(false);

  mock.setLinks([
    { source: { x: 10, y: 11, z: 12 }, target: { x: 20, y: 21, z: 22 } },
  ]);
  ctrl.rebuild();
  ctrl.onFrame();
  assert.equal(mock.batched(), undefined, 'a disabled graph swap allocates no batch');
  ctrl.setEnabled(true);

  const batch = mock.batched()!;
  const attribute = batch.geometry.getAttribute('position');
  const material = batch.material as THREE.LineBasicMaterial;
  assert.notEqual(batch, oldBatch);
  assert.notEqual(batch.geometry, oldBatch.geometry);
  assert.notEqual(material, oldMaterial);
  assert.notEqual(attribute.array, oldAttribute.array, 'position buffer recreated');
  assert.deepEqual([...attribute.array].slice(0, 6), [10, 11, 12, 20, 21, 22]);
  assert.equal(batch.geometry.drawRange.count, 2);
  assert.equal(batch.visible, true);
  assert.equal(batch.renderOrder, oldBatch.renderOrder);
  assert.equal(batch.frustumCulled, false);
  assert.equal(material.color.getHex(), oldMaterial.color.getHex());
  assert.equal(material.opacity, oldMaterial.opacity);
  assert.equal(material.transparent, oldMaterial.transparent);
  assert.equal(material.depthWrite, oldMaterial.depthWrite);

  const disposedAttributes: unknown[] = [];
  batch.geometry.addEventListener('dispose', () => {
    disposedAttributes.push(batch.geometry.getAttribute('position'));
  });
  mock.setLinks(makeLinks(400));
  ctrl.rebuild();
  const grownAttribute = batch.geometry.getAttribute('position');
  assert.deepEqual(disposedAttributes, [attribute], 'old buffer freed before replacement');
  assert.notEqual(grownAttribute, attribute);
  assert.ok(grownAttribute.array.length >= 420 * 6, 'growth reserves capacity slack');

  mock.setLinks(makeLinks(420));
  ctrl.rebuild();
  assert.equal(batch.geometry.getAttribute('position'), grownAttribute);
  assert.equal(disposedAttributes.length, 1, 'within-capacity rebuild reuses the buffer');
  ctrl.dispose();
  assert.deepEqual(disposedAttributes, [attribute, grownAttribute]);
});

test('re-enabling collapses unhydrated endpoints and re-captures visibility after hydration', () => {
  const mock = makeMockGraph(makeLinks(1));
  const ctrl = createInstancedLinks(mock.graph);
  ctrl.setEnabled(true);
  ctrl.setEnabled(false);

  const source = { x: 1, y: 2, z: 3 };
  const shown = { x: 4, y: 5, z: 6 };
  const hidden = { x: 7, y: 8, z: 9 };
  const links: Link[] = [
    { source: 'source', target: shown },
    { source, target: 'shown' },
    { source: 'source', target: 'hidden' },
  ];
  mock.setLinks(links);
  mock.setLinkVisibility((link: Link) => link.target !== hidden);
  ctrl.setEnabled(true);

  const batch = mock.batched()!;
  const attribute = batch.geometry.getAttribute('position');
  assert.equal(batch.geometry.drawRange.count, 6);
  assert.deepEqual([...attribute.array].slice(0, 18), [
    4, 5, 6, 4, 5, 6, // unhydrated source collapses onto target
    1, 2, 3, 1, 2, 3, // unhydrated target collapses onto source
    0, 0, 0, 0, 0, 0, // both endpoints unhydrated collapse at origin
  ]);

  // The library's digest hydrates the current links in place.
  links[0].source = source;
  links[1].target = shown;
  links[2].source = source;
  links[2].target = hidden;
  ctrl.onFrame();
  assert.equal(batch.geometry.drawRange.count, 4, 'hydrated hidden link dropped');
  assert.deepEqual([...attribute.array].slice(0, 12), [
    1, 2, 3, 4, 5, 6,
    1, 2, 3, 4, 5, 6,
  ]);
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

// Regression: a rebuild that runs before the library's debounced digest has
// hydrated link endpoints (string ids) can't judge visibility — the filter
// accessor keeps every link — so links to hidden nodes (out-of-window ghosts,
// hidden-ext files) were captured and later drawn as lines into empty space.
// Once hydration lands, the next frame must re-capture against the real nodes.
test('a pre-hydration capture is re-captured once endpoints hydrate', () => {
  type Node = Vec & { id: string; hidden?: boolean };
  type RawLink = { source: Node | string; target: Node | string };
  const dir: Node = { id: 'dir', x: 0, y: 0, z: 0 };
  const shown: Node = { id: 'shown', x: 1, y: 1, z: 0 };
  const ghost: Node = { id: 'ghost', x: 2, y: 2, z: 0, hidden: true };
  const links: RawLink[] = [
    { source: 'dir', target: 'shown' },
    { source: 'dir', target: 'ghost' },
  ];
  const nodeVisible = (n: Node | string) => typeof n === 'string' || !n.hidden;
  const scene = new THREE.Scene();
  const graph = {
    scene: () => scene,
    graphData: () => ({ links, nodes: [dir, shown, ghost] }),
    // Same shape as useGraphFilter's accessor: string endpoints read visible.
    linkVisibility: () => (l: RawLink) => nodeVisible(l.source) && nodeVisible(l.target),
    linkColor: () => '#f0f0f0',
    linkOpacity: () => 1,
    linkThreeObject: () => {},
    onEngineTick: () => {},
    onNodeDrag: () => {},
    onNodeDragEnd: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctrl = createInstancedLinks(graph as any);
  ctrl.setEnabled(true);
  const segments = () =>
    (scene.children.find((o) => o.userData['lattice:batchedLinks']) as THREE.LineSegments)
      .geometry.drawRange.count / 2;
  assert.equal(segments(), 2, 'pre-hydration: both links captured');

  // The digest hydrates endpoints in place.
  const byId = new Map([dir, shown, ghost].map((n) => [n.id, n]));
  for (const l of links) {
    l.source = byId.get(l.source as string)!;
    l.target = byId.get(l.target as string)!;
  }
  ctrl.onFrame();
  assert.equal(segments(), 1, 'the link to the hidden ghost is dropped');

  ctrl.dispose();
});
