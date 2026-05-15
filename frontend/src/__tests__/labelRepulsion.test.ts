import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  accumulatePairwiseForces,
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
