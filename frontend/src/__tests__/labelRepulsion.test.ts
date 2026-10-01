import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  accumulatePairwiseForces,
  cleanupStaleRegistryEntries,
  integrateLabelState,
  updateConnectorEndpoint,
  zeroDistanceJitter,
  type LabelState,
  type RepulsionEntry,
} from '../components/forceGraph/labelRepulsion.ts';

function approx(actual: number, expected: number, epsilon = 1e-12): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

test('zero-distance pair jitter uses a deterministic push direction', () => {
  const [dx, dz] = zeroDistanceJitter(0, 1);
  const angle = (0 * 12.9898 + 1 * 78.233) % (Math.PI * 2);
  approx(dx, Math.cos(angle) * 0.01);
  approx(dz, Math.sin(angle) * 0.01);
  approx(Math.hypot(dx, dz), 0.01);

  const fx = new Float32Array(2);
  const fz = new Float32Array(2);
  accumulatePairwiseForces(
    [
      [0, 0],
      [0, 0],
    ],
    55,
    fx,
    fz,
  );

  assert.ok(Number.isFinite(fx[0]));
  assert.ok(Number.isFinite(fz[0]));
  approx(fx[0] + fx[1], 0, 1e-7);
  approx(fz[0] + fz[1], 0, 1e-7);
  assert.ok(fx[1] * dx + fz[1] * dz > 0, 'second label pushes along jitter');
});

test('rest integration snaps tiny settled velocity after enough rest frames', () => {
  const state: LabelState = { vx: 0.01, vz: -0.005, restFrames: 5 };
  integrateLabelState(state, 0, 0);
  assert.deepEqual(state, { vx: 0, vz: 0, restFrames: 6 });
});

function makeLineEntry(secondPoint: THREE.Vector3): RepulsionEntry {
  const label = new THREE.Sprite();
  label.position.set(1, 100, 2);
  label.scale.set(10, 20, 1);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 3, 0),
      secondPoint,
    ]),
    new THREE.LineBasicMaterial(),
  );
  return { label, line };
}

test('connector endpoint update respects the epsilon threshold', () => {
  const within = makeLineEntry(new THREE.Vector3(1.0005, 89.9995, 2.0005));
  const withinAttr = within.line.geometry.getAttribute('position') as THREE.BufferAttribute;
  const withinVersion = withinAttr.version;
  assert.equal(updateConnectorEndpoint(within), false);
  assert.equal(withinAttr.version, withinVersion);
  approx(withinAttr.getX(1), 1.0005, 1e-7);

  const beyond = makeLineEntry(new THREE.Vector3(1.002, 90, 2));
  const beyondAttr = beyond.line.geometry.getAttribute('position') as THREE.BufferAttribute;
  const beyondVersion = beyondAttr.version;
  assert.equal(updateConnectorEndpoint(beyond), true);
  assert.ok(beyondAttr.version > beyondVersion);
  assert.equal(beyondAttr.getX(1), 1);
  assert.equal(beyondAttr.getY(1), 90);
  assert.equal(beyondAttr.getZ(1), 2);
});

test('stale cleanup releases a label under a detached ancestor once and preserves scene-connected labels', (t) => {
  const scene = new THREE.Scene();
  const surviving = makeLineEntry(new THREE.Vector3());
  const detached = makeLineEntry(new THREE.Vector3());
  const unparented = makeLineEntry(new THREE.Vector3());
  const entries = [surviving, detached, unparented];
  const registry = new Set(entries);
  const states = new WeakMap<THREE.Sprite, LabelState>();
  const originalStates = entries.map((entry, i) => {
    const state = { vx: i + 1, vz: -i - 1, restFrames: i };
    states.set(entry.label, state);
    return state;
  });
  const releases: RepulsionEntry[] = [];
  const onDetached = (entry: RepulsionEntry) => { releases.push(entry); };
  t.after(() => {
    registry.clear();
    for (const entry of entries) {
      states.delete(entry.label);
      entry.label.removeFromParent();
      entry.line.removeFromParent();
      entry.line.geometry.dispose();
      (entry.line.material as THREE.Material).dispose();
      entry.label.material.dispose();
    }
    scene.clear();
  });

  const survivingRoot = new THREE.Group();
  const survivingNested = new THREE.Group();
  survivingRoot.add(survivingNested);
  survivingNested.add(surviving.label, surviving.line);
  const detachedRoot = new THREE.Group();
  const detachedNested = new THREE.Group();
  detachedRoot.add(detachedNested);
  detachedNested.add(detached.label, detached.line);
  scene.add(survivingRoot, detachedRoot, unparented.label, unparented.line);

  cleanupStaleRegistryEntries(registry, states, onDetached);

  assert.equal(registry.size, 3);
  entries.forEach((entry, i) => {
    assert.ok(registry.has(entry));
    assert.equal(states.get(entry.label), originalStates[i], 'connected labels retain their state');
  });
  assert.equal(releases.length, 0, 'nested roots connected to a Scene need no release');

  scene.remove(detachedRoot);
  assert.equal(detachedRoot.parent, null);
  assert.equal(detached.label.parent, detachedNested, 'ancestor removal leaves the label parented');
  unparented.label.removeFromParent();
  assert.equal(unparented.label.parent, null);

  cleanupStaleRegistryEntries(registry, states, onDetached);

  assert.equal(registry.size, 1);
  assert.ok(registry.has(surviving));
  assert.equal(states.get(surviving.label), originalStates[0]);
  assert.equal(states.has(detached.label), false);
  assert.equal(states.has(unparented.label), false);
  assert.equal(releases.length, 1, 'direct unparenting requires no additional owning release');
  assert.equal(releases[0], detached, 'the owning callback receives the detached entry itself');

  cleanupStaleRegistryEntries(registry, states, onDetached);

  assert.equal(releases.length, 1, 'a second sweep cannot release the removed entry again');
  assert.equal(registry.size, 1);
  assert.ok(registry.has(surviving));
  assert.equal(states.get(surviving.label), originalStates[0]);
});
