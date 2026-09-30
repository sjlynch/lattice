import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { attachIdleController, type IdleController } from '../components/forceGraph/idleController.ts';
import { repelLabels, type RepulsionEntry } from '../components/forceGraph/labelRepulsion.ts';
import { startLabelRepulsion } from '../components/forceGraph/labelRepulsionFrames.ts';
import { REST_FRAMES } from '../components/forceGraph/labelPhysics/physics.ts';
import { entries, resetRepulsionScratch } from '../components/forceGraph/labelPhysics/scratchBuffers.ts';
import { attachFrameDriver, type FrameCallback } from '../components/forceGraph/sceneFrameDriver.ts';

afterEach(() => resetRepulsionScratch());

// Regression: the module-level `entries` scratch array was only trimmed by the
// next non-empty `repelLabels` tick, so once an overlay's labels were cleared
// it kept every last-frame label sprite (and its material/texture/canvas)
// reachable indefinitely. An empty tick must drop them.
function entryInScene(scene: THREE.Scene, x: number, t: TestContext): RepulsionEntry {
  const root = new THREE.Group();
  scene.add(root);
  const label = new THREE.Sprite();
  label.position.set(x, 10, 0);
  root.add(label);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 10, 0)]),
    new THREE.LineBasicMaterial(),
  );
  root.add(line);
  t.after(() => {
    root.removeFromParent();
    line.geometry.dispose();
    line.material.dispose();
    label.material.dispose();
  });
  return { label, line };
}

test('an empty repulsion tick releases the scratch references to the last labels', (t) => {
  const scene = new THREE.Scene();
  const registry = new Set<RepulsionEntry>([entryInScene(scene, 0, t), entryInScene(scene, 1, t)]);
  repelLabels(registry, 20);
  assert.equal(entries.length, 2, 'a live tick fills the scratch list');

  registry.clear();
  assert.equal(repelLabels(registry, 20), true);
  assert.equal(entries.length, 0, 'no label sprite stays reachable from the scratch list');
});

type DriverState = { callbacks: Set<FrameCallback>; list: FrameCallback[] };

function makeGraph() {
  const scene = new THREE.Scene();
  const graph = { scene: () => scene } as unknown as ForceGraph3DInstance;
  const idle = {
    acquires: 0,
    releases: 0,
    held: 0,
    acquireLabelPhysics() { this.acquires++; this.held++; },
    // Count every decrement so a double release cannot hide behind a clamp.
    releaseLabelPhysics() { this.releases++; this.held--; },
  };
  attachIdleController(graph, idle as unknown as IdleController);
  attachFrameDriver(graph);
  return {
    graph,
    scene,
    idle,
    frame: () => (scene.onBeforeRender as () => void)(),
    // Match sceneFrameDriver.test.ts: inspect ownership without GC or another
    // frame, since an overlay can stop while the scene stays paused forever.
    driver: (graph as unknown as { __frameDriver: DriverState }).__frameDriver,
  };
}

for (const settled of [false, true]) {
  test(`stopping label repulsion ${settled ? 'after rest' : 'while held'} cleans up without another render`, (t) => {
    const mock = makeGraph();
    // A single label at its anchor reaches rest without force or jitter;
    // nearby labels keep the other case moving after its first frame.
    const positions = settled ? [0] : [0, 1];
    const registry = new Set(positions.map((x) => entryInScene(mock.scene, x, t)));
    const stop = startLabelRepulsion(mock.graph, registry, () => 20);
    t.after(stop);
    const [callback] = mock.driver.callbacks;
    assert.ok(callback);
    assert.equal(mock.idle.acquires, 1, 'mount acquires one labelPhysics hold');
    assert.equal(mock.idle.held, 1);
    assert.equal(mock.idle.releases, 0);

    for (let i = 0; i < (settled ? REST_FRAMES : 1); i++) mock.frame();
    assert.deepEqual(entries, [...registry], 'real frames fill the scratch list');
    assert.deepEqual(mock.driver.list, [callback], 'a frame caches the subscription');
    assert.equal(mock.idle.acquires, 1, 'ticks do not acquire a second hold');
    assert.equal(mock.idle.releases, settled ? 1 : 0);
    assert.equal(mock.idle.held, settled ? 0 : 1);

    stop();
    // Deliberately never render again: cleanup itself must release ownership.
    assert.equal(entries.length, 0, 'cleanup immediately drops last-frame labels');
    assert.equal(mock.driver.callbacks.has(callback), false);
    assert.equal(mock.driver.callbacks.size, 0);
    assert.equal(mock.driver.list.includes(callback), false);
    assert.equal(mock.driver.list.length, 0);
    assert.equal(mock.idle.releases, 1, 'release only the outstanding hold');
    assert.equal(mock.idle.held, 0);

    stop();
    assert.equal(mock.idle.releases, 1, 'repeated stop does not release again');
    assert.equal(mock.idle.held, 0);
    assert.equal(mock.driver.callbacks.size, 0);
    assert.equal(mock.driver.list.length, 0);
    assert.equal(entries.length, 0);
  });
}

test('stopping one overlay preserves the survivor subscription and idle hold', (t) => {
  const mock = makeGraph();
  const survivor = new Set([entryInScene(mock.scene, 0, t)]);
  const stopped = new Set([entryInScene(mock.scene, 0, t), entryInScene(mock.scene, 1, t)]);
  let survivorTicks = 0;
  let stoppedTicks = 0;
  const stopSurvivor = startLabelRepulsion(mock.graph, survivor, () => { survivorTicks++; return 20; });
  const stopOther = startLabelRepulsion(mock.graph, stopped, () => { stoppedTicks++; return 20; });
  t.after(stopSurvivor);
  t.after(stopOther);
  const [survivorCallback, stoppedCallback] = mock.driver.callbacks;
  assert.ok(survivorCallback);
  assert.ok(stoppedCallback);

  mock.frame();
  assert.deepEqual(mock.driver.list, [survivorCallback, stoppedCallback]);
  assert.deepEqual(entries, [...stopped], 'the overlay being stopped was the last scratch writer');
  assert.equal(mock.idle.acquires, 2);
  assert.equal(mock.idle.releases, 0);
  assert.equal(mock.idle.held, 2);
  assert.equal(survivorTicks, 1);
  assert.equal(stoppedTicks, 1);

  stopOther();
  assert.equal(entries.length, 0, 'shared scratch clears before the survivor ticks');
  assert.deepEqual([...mock.driver.callbacks], [survivorCallback]);
  assert.equal(mock.driver.list.includes(stoppedCallback), false);
  assert.equal(mock.idle.releases, 1);
  assert.equal(mock.idle.held, 1, 'the survivor still owns its labelPhysics hold');
  stopOther();
  assert.equal(mock.idle.releases, 1, 'repeated stop cannot take the survivor hold');
  assert.equal(mock.idle.held, 1);

  mock.frame();
  assert.equal(stoppedTicks, 1, 'the stopped registry never ticks again');
  assert.equal(survivorTicks, 2);
  assert.deepEqual(mock.driver.list, [survivorCallback]);
  assert.deepEqual(entries, [...survivor], 'scratch rebuilds solely from the live registry');
  assert.equal(mock.idle.acquires, 2);
  assert.equal(mock.idle.releases, 1);
  assert.equal(mock.idle.held, 1);

  // Finish the survivor's real rest window with its nonempty registry intact.
  for (let i = 2; i < REST_FRAMES; i++) mock.frame();
  assert.equal(survivorTicks, REST_FRAMES);
  assert.equal(stoppedTicks, 1);
  assert.equal(mock.idle.releases, 2, 'the survivor releases its own hold at rest');
  assert.equal(mock.idle.held, 0);

  stopSurvivor();
  assert.equal(mock.idle.releases, 2, 'cleanup after survivor rest does not release twice');
  assert.equal(mock.idle.held, 0);
  assert.equal(mock.driver.callbacks.size, 0);
  assert.equal(mock.driver.list.length, 0);
  assert.equal(entries.length, 0);
});
