import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { repelLabels, type RepulsionEntry } from '../components/forceGraph/labelRepulsion.ts';
import { entries } from '../components/forceGraph/labelPhysics/scratchBuffers.ts';

// Regression: the module-level `entries` scratch array was only trimmed by the
// next non-empty `repelLabels` tick, so once an overlay's labels were cleared
// it kept every last-frame label sprite (and its material/texture/canvas)
// reachable indefinitely. An empty tick must drop them.
function entryInScene(scene: THREE.Scene, x: number): RepulsionEntry {
  const root = new THREE.Group();
  scene.add(root);
  const label = new THREE.Sprite();
  label.position.set(x, 10, 0);
  root.add(label);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 10, 0)]),
  );
  root.add(line);
  return { label, line };
}

test('an empty repulsion tick releases the scratch references to the last labels', () => {
  const scene = new THREE.Scene();
  const registry = new Set<RepulsionEntry>([entryInScene(scene, 0), entryInScene(scene, 1)]);
  repelLabels(registry, 20);
  assert.equal(entries.length, 2, 'a live tick fills the scratch list');

  registry.clear();
  assert.equal(repelLabels(registry, 20), true);
  assert.equal(entries.length, 0, 'no label sprite stays reachable from the scratch list');
});
