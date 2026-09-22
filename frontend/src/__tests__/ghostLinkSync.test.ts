import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installCanvasDocument } from './domDoubles.ts';

// The change-ring / sprite modules paint on a 2D canvas, so stub just enough of
// the DOM for THREE to mint a CanvasTexture under `node --test` (no jsdom).
// Installed before importing the modules under test — same as
// `changeRingSuppression.test.ts`.
installCanvasDocument();

const THREE = await import('three');
const { applyChangeRingDelta } = await import(
  '../components/forceGraph/changeRingSync.ts'
);
const { createInstancedLinks } = await import(
  '../components/forceGraph/instancedLinks.ts'
);
const { GHOST_PREFIX } = await import('../components/forceGraph/timelineDiff.ts');
const { DEFAULT_SETTINGS } = await import(
  '../components/forceGraph/graphSettings.ts'
);
type ChangeKind = import('../components/forceGraph/changeRing.ts').ChangeKind;

const SCAN_ROOT = 'C:/proj';
const GONE = 'src/gone.ts';

type MountedNode = {
  id: string;
  name: string;
  path: string;
  kind: 'dir' | 'file';
  x: number;
  y: number;
  z: number;
  __threeObj?: InstanceType<typeof THREE.Object3D>;
};

type MountedLink = {
  source: MountedNode;
  target: MountedNode;
  __lineObj?: InstanceType<typeof THREE.Object3D>;
};

// One directory node plus one ghost (deleted-file) node linked to it — the
// shape `buildGhostGraphData` mints. `mountGhost: false` reproduces the state a
// `graph.refresh()` leaves behind when the ghost was outside the scrubber
// window: the library's digest drops the node from the scene and deletes its
// `__threeObj`, so there is nothing left to toggle back on.
function makeGraph(
  changeMap: Map<string, ChangeKind>,
  { mountGhost = true }: { mountGhost?: boolean } = {},
) {
  const scene = new THREE.Scene();
  const dir: MountedNode = {
    id: `${SCAN_ROOT}/src`,
    name: 'src',
    path: `${SCAN_ROOT}/src`,
    kind: 'dir',
    x: 0,
    y: 0,
    z: 0,
    __threeObj: new THREE.Group(),
  };
  const ghost: MountedNode = {
    id: `${GHOST_PREFIX}${GONE}`,
    name: 'gone.ts',
    path: GONE,
    kind: 'file',
    x: 5,
    y: 5,
    z: 5,
  };
  if (mountGhost) ghost.__threeObj = new THREE.Group();
  const link: MountedLink = { source: dir, target: ghost };
  if (mountGhost) link.__lineObj = new THREE.Object3D();

  // `changeMapRef.current` is swapped to the NEXT map before the delta runs
  // (see useGitTimeline), so the accessors below must read it live — exactly
  // like the real `useGraphFilter` closures.
  let map = changeMap;
  const nodeVisible = (n: MountedNode) =>
    n.id.startsWith(GHOST_PREFIX) ? map.has(n.path) : true;

  let refreshes = 0;
  const graph = {
    scene: () => scene,
    graphData: () => ({ nodes: [dir, ghost], links: [link] }),
    linkVisibility: () => (l: MountedLink) =>
      nodeVisible(l.source) && nodeVisible(l.target),
    linkColor: () => '#f0f0f0',
    linkOpacity: () => 1,
    linkThreeObject: () => {},
    refresh: () => {
      refreshes++;
    },
    enablePointerInteraction: () => {},
    // node-motion driver sinks (gate.attach subscribes through these)
    onEngineTick: () => {},
    onNodeDrag: () => {},
    onNodeDragEnd: () => {},
  };

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graph: graph as any,
    dir,
    ghost,
    link,
    refreshes: () => refreshes,
    // Drive the delta the way useGitTimeline does: publish the next map, then
    // apply the prev→next diff.
    scrub(prev: Map<string, ChangeKind>, next: Map<string, ChangeKind>) {
      map = next;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return applyChangeRingDelta(graph as any, prev, next, DEFAULT_SETTINGS, SCAN_ROOT);
    },
    batchedSegments: () =>
      scene.children.find((o) => o.userData['lattice:batchedLinks']) as
        | InstanceType<typeof THREE.LineSegments>
        | undefined,
  };
}

const deleted = () => new Map<string, ChangeKind>([[GONE, 'deleted']]);
const empty = () => new Map<string, ChangeKind>();

// THE BUG: scrubbing the timeline past a file's deletion commit hid the small
// grey ghost disc (its `__threeObj` is toggled in place) but left the line to
// its parent directory drawn — `linkVisibility` is only ever consulted by the
// library's digest, which this delta deliberately avoids. The link object must
// follow the node.
test('scrubbing a ghost out of the window hides its link too', () => {
  const g = makeGraph(deleted());
  assert.equal(g.ghost.__threeObj!.visible, true);

  g.scrub(deleted(), empty());

  assert.equal(g.ghost.__threeObj!.visible, false, 'ghost disc hidden');
  assert.equal(g.link.__lineObj!.visible, false, 'ghost link hidden with it');
});

// Symmetric: scrubbing back over the deletion restores both.
test('scrubbing a ghost back into the window restores its link', () => {
  const g = makeGraph(deleted());
  g.scrub(deleted(), empty());
  g.scrub(empty(), deleted());

  assert.equal(g.ghost.__threeObj!.visible, true, 'ghost disc shown');
  assert.equal(g.link.__lineObj!.visible, true, 'ghost link shown with it');
});

// The batched renderer (`batchedLinks`, on by default) draws from a link array
// captured at its last rebuild, so hiding the per-link object isn't enough — it
// has to re-read `linkVisibility` or the segment stays in the buffer.
test('the batched link buffer drops the segment when the ghost vanishes', () => {
  const g = makeGraph(deleted());
  const ctrl = createInstancedLinks(g.graph);
  ctrl.setEnabled(true); // captures the one visible ghost link
  assert.equal(g.batchedSegments()!.geometry.drawRange.count, 2, 'one segment drawn');

  g.scrub(deleted(), empty());
  assert.equal(
    g.batchedSegments()!.geometry.drawRange.count,
    0,
    'segment gone from the batched buffer',
  );

  // ...and comes back with the ghost.
  g.scrub(empty(), deleted());
  assert.equal(g.batchedSegments()!.geometry.drawRange.count, 2);

  ctrl.dispose();
});

// A ghost the delta can't show — an earlier `graph.refresh()` ran while it was
// outside the window, so the digest dropped it from the scene entirely — has no
// object to toggle. Fall back to a refresh so the node AND its link remount.
test('an unmounted ghost that should show falls back to a refresh', () => {
  const g = makeGraph(empty(), { mountGhost: false });
  assert.equal(g.refreshes(), 0);

  const changed = g.scrub(empty(), deleted());

  assert.equal(g.refreshes(), 1, 'requested a re-digest');
  assert.equal(changed, true, 'reports a change so the caller wakes a frame');
});

// The reverse of the above must NOT refresh: an unmounted ghost that should
// stay hidden is already in the right state, and a refresh per scrubber notch
// would rebuild every node sprite.
test('an unmounted ghost that should stay hidden does not refresh', () => {
  const g = makeGraph(deleted(), { mountGhost: false });

  g.scrub(deleted(), empty());

  assert.equal(g.refreshes(), 0, 'no refresh for a ghost that stays hidden');
});

// Regression: the in-place hide only flipped `.visible`, which THREE's
// Raycaster ignores — the hidden ghost stayed hoverable/draggable over empty
// space (its "(deleted)" tooltip) and stole hover from nodes behind it. A
// hidden ghost must drop out of picking and come back when shown again.
test('a ghost scrubbed out of the window is no longer pickable', () => {
  const g = makeGraph(deleted());
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  g.ghost.__threeObj!.add(body);
  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(0, 0, 10),
    new THREE.Vector3(0, 0, -1),
  );
  const hits = () => raycaster.intersectObject(g.ghost.__threeObj!, true).length;
  assert.ok(hits() > 0, 'a shown ghost is pickable');

  g.scrub(deleted(), empty());
  assert.equal(hits(), 0, 'a hidden ghost is not pickable');

  g.scrub(empty(), deleted());
  assert.ok(hits() > 0, 'pickable again once shown');
});
