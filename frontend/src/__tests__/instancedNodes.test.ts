import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode } from '../api/index.ts';
import { getStyleFor } from '../extensionStyles.ts';
import { DEFAULT_SETTINGS } from '../components/forceGraph/graphSettings.ts';
import { createInstancedNodes } from '../components/forceGraph/instancedNodes.ts';
import { materialFor } from '../components/forceGraph/sprites.ts';
import { installCanvasDocument } from './domDoubles.ts';

type SimNode = GraphNode & { x: number; y: number; z: number };
type NodeMesh = THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
type DisposeOwner = {
  addEventListener(type: 'dispose', listener: () => void): void;
  removeEventListener(type: 'dispose', listener: () => void): void;
};

function makeNodes(count: number, ext = '.ts'): SimNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${i}${ext}`, name: `${i}${ext}`, path: `/project/${i}${ext}`,
    kind: 'file', ext, x: i + 1, y: i + 2, z: i + 3,
  }));
}

function makeMockGraph(initial: SimNode[]) {
  const scene = new THREE.Scene();
  let nodes = initial;
  let visibility: unknown = undefined;
  let tick = () => {};
  const added: NodeMesh[] = [];
  scene.addEventListener('childadded', ({ child }) => {
    if (child instanceof THREE.InstancedMesh) added.push(child as NodeMesh);
  });
  const graph = {
    scene: () => scene,
    graphData: () => ({ nodes, links: [] }),
    nodeVisibility: () => visibility,
    onEngineTick: (fn: () => void) => { tick = fn; },
    onNodeDrag: () => {},
    onNodeDragEnd: () => {},
  };
  const meshes = () => scene.children.filter(
    (child): child is NodeMesh => child instanceof THREE.InstancedMesh,
  );
  return {
    graph: graph as unknown as ForceGraph3DInstance,
    meshes, added,
    meshFor: (ext: string) => meshes().find(
      (mesh) => mesh.material.map === materialFor(getStyleFor(ext)).map,
    )!,
    setNodes: (next: SimNode[]) => { nodes = next; },
    setVisibility: (next: unknown) => { visibility = next; },
    tick: () => tick(),
    // Inspect the existing stamp, as in nodeMotionDriver.test.ts, so release
    // assertions need neither GC nor a subsequent motion event.
    driver: () => (graph as unknown as {
      __nodeMotionDriver: { listeners: Set<() => void>; list: (() => void)[] };
    }).__nodeMotionDriver,
  };
}

function makeController(t: TestContext, graph: ForceGraph3DInstance) {
  const ctrl = createInstancedNodes(graph, {
    getSettings: () => DEFAULT_SETTINGS,
    isBaseView: () => true,
  });
  let disposed = false;
  t.after(() => { if (!disposed) ctrl.dispose(); });
  return {
    ctrl,
    dispose: () => { ctrl.dispose(); disposed = true; },
  };
}

// Listen on the actual owners; remove even cached-texture listeners in teardown.
function watchDisposals(t: TestContext, ...owners: DisposeOwner[]): number[] {
  const counts = owners.map(() => 0);
  owners.forEach((owner, i) => {
    const listener = () => { counts[i]++; };
    owner.addEventListener('dispose', listener);
    t.after(() => owner.removeEventListener('dispose', listener));
  });
  return counts;
}

test('style growth releases only the replaced mesh and material and reuses slack', (t) => {
  t.after(installCanvasDocument());
  const otherNodes = makeNodes(1, '.md');
  const mock = makeMockGraph([...makeNodes(1), ...otherNodes]);
  const { ctrl } = makeController(t, mock.graph);
  ctrl.setEnabled(true);
  const oldMesh = mock.meshFor('.ts');
  const otherMesh = mock.meshFor('.md');
  const oldMatrix = oldMesh.instanceMatrix;
  const oldDisposals = watchDisposals(t, oldMesh, oldMesh.material);
  const otherDisposals = watchDisposals(t, otherMesh, otherMesh.material);
  const sharedDisposals = watchDisposals(
    t, oldMesh.geometry, oldMesh.material.map!, otherMesh.material.map!,
  );
  assert.equal(otherMesh.geometry, oldMesh.geometry, 'styles share one quad');

  const grownCount = oldMatrix.count + 1;
  mock.setNodes([...makeNodes(grownCount), ...otherNodes]);
  ctrl.rebuild();
  const grownMesh = mock.meshFor('.ts');
  const grownMatrix = grownMesh.instanceMatrix;
  const grownStorage = grownMatrix.array;
  const grownDisposals = watchDisposals(t, grownMesh, grownMesh.material);
  assert.notEqual(grownMesh, oldMesh);
  assert.notEqual(grownMesh.material, oldMesh.material);
  assert.equal(oldMesh.parent, null, 'replaced mesh leaves the scene');
  assert.deepEqual(oldDisposals, [1, 1], 'mesh buffer and material released once');
  assert.notEqual(grownMatrix, oldMatrix);
  assert.notEqual(grownMatrix.array, oldMatrix.array);
  assert.equal(grownMesh.geometry, oldMesh.geometry);
  assert.equal(grownMesh.material.map, oldMesh.material.map);
  assert.ok(grownMatrix.count >= grownCount + 1, 'growth reserves slack');

  mock.setNodes([...makeNodes(grownCount + 1), ...otherNodes]);
  ctrl.rebuild();
  assert.equal(mock.meshFor('.ts'), grownMesh);
  assert.equal(grownMesh.instanceMatrix, grownMatrix);
  assert.equal(grownMesh.instanceMatrix.array, grownStorage);
  assert.equal(grownMesh.count, grownCount + 1);
  assert.equal(mock.meshFor('.md'), otherMesh, 'unaffected style stays mounted');
  assert.equal(mock.added.length, 3, 'within-slack rebuild creates no new mesh');
  assert.deepEqual(oldDisposals, [1, 1]);
  assert.deepEqual(grownDisposals, [0, 0]);
  assert.deepEqual(otherDisposals, [0, 0]);
  assert.deepEqual(sharedDisposals, [0, 0, 0], 'quad and cache textures survive');
});

test('filter removal and disable release styles once and re-enable uses current nodes', (t) => {
  t.after(installCanvasDocument());
  const mock = makeMockGraph([...makeNodes(1), ...makeNodes(1, '.md')]);
  const { ctrl } = makeController(t, mock.graph);
  ctrl.setEnabled(true);
  const removed = mock.meshFor('.ts');
  const remaining = mock.meshFor('.md');
  const removedDisposals = watchDisposals(t, removed, removed.material);
  const remainingDisposals = watchDisposals(t, remaining, remaining.material);
  const quad = removed.geometry;
  const textures = [removed.material.map!, remaining.material.map!];
  const sharedDisposals = watchDisposals(t, quad, ...textures);

  mock.setVisibility((node: SimNode) => node.ext !== '.ts');
  ctrl.rebuild();
  assert.deepEqual(mock.meshes(), [remaining]);
  assert.equal(removed.parent, null);
  assert.deepEqual(removedDisposals, [1, 1]);
  assert.deepEqual(remainingDisposals, [0, 0]);

  ctrl.setEnabled(false);
  assert.equal(remaining.parent, null);
  assert.deepEqual(removedDisposals, [1, 1]);
  assert.deepEqual(remainingDisposals, [1, 1]);
  assert.deepEqual(sharedDisposals, [0, 0, 0], 'temporary disable keeps shared resources');

  const currentNodes = [
    { ...makeNodes(1)[0], x: 10, y: 11, z: 12 },
    { ...makeNodes(1, '.md')[0], x: 20, y: 21, z: 22 },
  ];
  mock.setNodes(currentNodes);
  mock.setVisibility(() => true);
  ctrl.rebuild();
  ctrl.onFrame();
  ctrl.setEnabled(false);
  assert.deepEqual(mock.meshes(), []);
  assert.equal(mock.added.length, 2, 'disabled hooks and repeated disable allocate no meshes');
  assert.deepEqual(removedDisposals, [1, 1]);
  assert.deepEqual(remainingDisposals, [1, 1]);

  ctrl.setEnabled(true);
  for (const [i, ext] of ['.ts', '.md'].entries()) {
    const fresh = mock.meshFor(ext);
    const old = [removed, remaining][i];
    assert.notEqual(fresh, old);
    assert.notEqual(fresh.material, old.material);
    assert.notEqual(fresh.instanceMatrix.array, old.instanceMatrix.array);
    assert.equal(fresh.geometry, quad);
    assert.equal(fresh.material.map, textures[i], 'cached texture reused');
    assert.deepEqual(Array.from(fresh.instanceMatrix.array.slice(12, 15)),
      i === 0 ? [10, 11, 12] : [20, 21, 22]);
    assert.ok(textures[i].image.width > 0, 'sprite texture pixels remain usable');
  }
  assert.deepEqual(sharedDisposals, [0, 0, 0]);
});

test('final disposal from enabled or disabled releases owners and motion subscription immediately', (t) => {
  t.after(installCanvasDocument());
  for (const disabled of [false, true]) {
    const mock = makeMockGraph([...makeNodes(1), ...makeNodes(1, '.md')]);
    const { ctrl, dispose } = makeController(t, mock.graph);
    ctrl.setEnabled(true);
    const meshes = mock.meshes();
    const ownedDisposals = watchDisposals(t, ...meshes.flatMap((mesh) => [mesh, mesh.material]));
    const sharedDisposals = watchDisposals(t, meshes[0].geometry,
      ...meshes.map((mesh) => mesh.material.map!));
    mock.tick(); // Populate the driver's cached callback snapshot before teardown.
    const driver = mock.driver();
    assert.equal(driver.listeners.size, 1);
    assert.equal(driver.list.length, 1);

    if (disabled) {
      ctrl.setEnabled(false);
      assert.deepEqual(ownedDisposals, [1, 1, 1, 1]);
      assert.deepEqual(sharedDisposals, [0, 0, 0]);
      assert.equal(driver.listeners.size, 0);
      assert.equal(driver.list.length, 0, 'disable releases the cached callback immediately');
    }
    dispose(); // Exactly one final dispose per controller.
    assert.deepEqual(mock.meshes(), []);
    assert.ok(meshes.every((mesh) => mesh.parent === null));
    assert.deepEqual(ownedDisposals, [1, 1, 1, 1]);
    assert.deepEqual(sharedDisposals, [1, 0, 0], 'only the shared quad is controller-owned');
    assert.equal(driver.listeners.size, 0, 'motion subscription released without another tick');
    assert.equal(driver.list.length, 0, 'cached callback released without another tick');
  }
});
