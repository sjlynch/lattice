import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forceLocalRepulsion } from '../components/forceGraph/localRepulsionForce.ts';

type Node = { x: number; z: number; vx: number; vz: number; y?: number; vy?: number };

function node(x: number, z: number): Node {
  return { x, z, vx: 0, vz: 0 };
}

test('two nearby nodes are pushed directly apart, symmetrically', () => {
  const a = node(0, 0);
  const b = node(10, 0); // within default cellSize (60) interaction radius
  const force = forceLocalRepulsion().strength(-30).cellSize(60);
  force.initialize([a, b]);
  force(1);

  // a sits left of b → a pushed −x, b pushed +x, equal & opposite.
  assert.ok(a.vx < 0, 'left node pushed left');
  assert.ok(b.vx > 0, 'right node pushed right');
  assert.ok(Math.abs(a.vx + b.vx) < 1e-9, 'x impulse is symmetric');
  // Purely horizontal separation → no z impulse.
  assert.ok(Math.abs(a.vz) < 1e-9 && Math.abs(b.vz) < 1e-9, 'no spurious z force');
});

test('nodes beyond the interaction radius do not interact', () => {
  const a = node(0, 0);
  const b = node(500, 0); // far outside cellSize
  const force = forceLocalRepulsion().strength(-30).cellSize(60);
  force.initialize([a, b]);
  force(1);
  assert.equal(a.vx, 0, 'distant node exerts no force');
  assert.equal(b.vx, 0, 'distant node exerts no force');
});

test('never writes a Y impulse (Y is pinned by fy in td mode)', () => {
  const a: Node = { x: 0, z: 0, vx: 0, vz: 0, y: 5, vy: 0 };
  const b: Node = { x: 8, z: 6, vx: 0, vz: 0, y: 5, vy: 0 };
  const force = forceLocalRepulsion().strength(-30).cellSize(60);
  force.initialize([a, b]);
  force(1);
  assert.equal(a.vy, 0, 'no vy written');
  assert.equal(b.vy, 0, 'no vy written');
});

test('strength scales the impulse and sign convention matches d3 (negative = repel)', () => {
  const mk = () => [node(0, 0), node(10, 0)] as const;
  const weak = mk();
  const fWeak = forceLocalRepulsion().strength(-30).cellSize(60);
  fWeak.initialize(weak as unknown as Node[]);
  fWeak(1);

  const strong = mk();
  const fStrong = forceLocalRepulsion().strength(-60).cellSize(60);
  fStrong.initialize(strong as unknown as Node[]);
  fStrong(1);

  // Doubling the (negative) charge strength doubles the repulsive impulse.
  assert.ok(strong[1].vx > weak[1].vx, 'stronger repulsion pushes harder');
  assert.ok(Math.abs(strong[1].vx - 2 * weak[1].vx) < 1e-9, 'impulse is linear in strength');
});

test('coincident nodes separate instead of producing NaN', () => {
  const a = node(0, 0);
  const b = node(0, 0);
  const force = forceLocalRepulsion().strength(-30).cellSize(60);
  force.initialize([a, b]);
  force(1);
  assert.ok(Number.isFinite(a.vx) && Number.isFinite(a.vz), 'finite impulse');
  assert.ok(a.vx !== 0 || a.vz !== 0, 'coincident pair gets a separating kick');
});

test('alpha=0 produces no motion', () => {
  const a = node(0, 0);
  const b = node(10, 0);
  const force = forceLocalRepulsion().strength(-30).cellSize(60);
  force.initialize([a, b]);
  force(0);
  assert.equal(a.vx, 0);
  assert.equal(b.vx, 0);
});
