import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forceCollideXZ } from '../components/forceGraph/layoutShapeForces.ts';

type N = { id?: string; x?: number; z?: number; vx?: number; vz?: number };

test('collide force separates two overlapping nodes', () => {
  const f = forceCollideXZ().radius(20).strength(1);
  // Centers 10 apart, diameter 40 → overlapping.
  const a: N = { x: 0, z: 0, vx: 0, vz: 0 };
  const b: N = { x: 10, z: 0, vx: 0, vz: 0 };
  f.initialize([a, b]);
  f(1);
  assert.ok((a.vx ?? 0) < 0, 'left node pushed further left');
  assert.ok((b.vx ?? 0) > 0, 'right node pushed further right');
  // Equal and opposite (uniform radius → even split).
  assert.ok(Math.abs((a.vx ?? 0) + (b.vx ?? 0)) < 1e-9, 'impulses are opposite');
});

test('collide force leaves well-separated nodes untouched', () => {
  const f = forceCollideXZ().radius(20).strength(1);
  const a: N = { x: 0, z: 0, vx: 0, vz: 0 };
  const b: N = { x: 100, z: 0, vx: 0, vz: 0 }; // 100 > diameter 40
  f.initialize([a, b]);
  f(1);
  assert.equal(a.vx, 0);
  assert.equal(b.vx, 0);
});

test('collide force is inert at radius 0', () => {
  const f = forceCollideXZ().radius(0).strength(1);
  const a: N = { x: 0, z: 0, vx: 0, vz: 0 };
  const b: N = { x: 1, z: 0, vx: 0, vz: 0 };
  f.initialize([a, b]);
  f(1);
  assert.equal(a.vx, 0);
  assert.equal(b.vx, 0);
});

test('collide force gives coincident nodes a finite deterministic kick', () => {
  const f = forceCollideXZ().radius(20).strength(1);
  const a: N = { x: 5, z: 5, vx: 0, vz: 0 };
  const b: N = { x: 5, z: 5, vx: 0, vz: 0 };
  f.initialize([a, b]);
  f(1);
  // No NaN/Infinity from a div-by-zero, and they do get pushed apart.
  assert.ok(Number.isFinite(a.vx ?? NaN) && Number.isFinite(a.vz ?? NaN));
  assert.ok((a.vx ?? 0) !== 0 || (a.vz ?? 0) !== 0, 'coincident pair separates');
});
