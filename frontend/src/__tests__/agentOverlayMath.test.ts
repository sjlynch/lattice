import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseName,
  hoverMargin,
  normalizePath,
} from '../components/forceGraph/agentOverlayPathIndex.ts';
import { beamFade } from '../components/forceGraph/agentOverlayBeams.ts';
import {
  freeSatelliteSlot,
  HoverLine,
  lowPassStep,
  parkedPosition,
  satelliteOffset,
} from '../components/forceGraph/agentOverlayPlacement.ts';
import {
  SATELLITE_DROP_FACTOR,
  SATELLITE_RING_RADIUS,
} from '../components/forceGraph/agentOverlayConstants.ts';

test('normalizePath lowercases and forward-slashes', () => {
  assert.equal(normalizePath('Src\\Components\\App.TS'), 'src/components/app.ts');
});

test('baseName returns the last path segment', () => {
  assert.equal(baseName('src\\components\\App.tsx'), 'App.tsx');
  assert.equal(baseName('src/components/App.tsx'), 'App.tsx');
  assert.equal(baseName('App.tsx'), 'App.tsx');
});

test('hoverMargin clamps the fractional margin to [min, max]', () => {
  // Small tree → clamps up to the 25 floor (10% of 100 = 10).
  assert.equal(hoverMargin({ minY: 0, maxY: 100 }), 25);
  // Mid tree → the 10% fraction (10% of 1000 = 100) is used as-is.
  assert.equal(hoverMargin({ minY: 0, maxY: 1000 }), 100);
  // Tall tree → clamps down to the 220 ceiling (10% of 5000 = 500).
  assert.equal(hoverMargin({ minY: 0, maxY: 5000 }), 220);
});

test('beamFade is full until the last 700ms, then ramps to 0', () => {
  assert.equal(beamFade(2000), 1);
  assert.equal(beamFade(700), 1);
  assert.equal(beamFade(350), 0.5);
  assert.equal(beamFade(0), 0);
  assert.equal(beamFade(-100), 0); // never negative
});

test('lowPassStep eases current toward target', () => {
  assert.equal(lowPassStep(0, 10, 0.5), 5);
  assert.equal(lowPassStep(10, 10, 0.5), 10); // already at target
  assert.equal(lowPassStep(0, 100, 0.12), 12);
});

test('parkedPosition pins Y and spreads X/Z on a golden-angle spiral', () => {
  const center = { cx: 5, cz: 7, maxR: 100, y: 42 };
  const p0 = parkedPosition(0, center);
  // index 0 → angle 0 → cos=1, sin=0; r = 100*0.6 + 20 = 80.
  assert.equal(p0.y, 42);
  assert.ok(Math.abs(p0.x - (5 + 80)) < 1e-9);
  assert.ok(Math.abs(p0.z - 7) < 1e-9);
  // Distinct index → distinct spot, same radius from the centroid.
  const p1 = parkedPosition(1, center);
  const r1 = Math.hypot(p1.x - center.cx, p1.z - center.cz);
  assert.ok(Math.abs(r1 - 80) < 1e-9);
  assert.notEqual(p1.x, p0.x);
});

test('satelliteOffset rings around the parent at a nodeSize-scaled radius', () => {
  const nodeSize = 10;
  const o0 = satelliteOffset(0, nodeSize);
  // slot 0 → angle 0 → cos=1, sin=0; radius = nodeSize * SATELLITE_RING_RADIUS.
  const r = nodeSize * SATELLITE_RING_RADIUS;
  assert.ok(Math.abs(o0.dx - r) < 1e-9);
  assert.ok(Math.abs(o0.dz - 0) < 1e-9);
  // Always dropped below the parent by the same amount, regardless of slot.
  assert.equal(o0.dy, -nodeSize * SATELLITE_DROP_FACTOR);
  // Distinct slot → distinct direction, same ring radius + same drop.
  const o1 = satelliteOffset(1, nodeSize);
  assert.ok(Math.abs(Math.hypot(o1.dx, o1.dz) - r) < 1e-9);
  assert.equal(o1.dy, o0.dy);
  assert.notEqual(o1.dx, o0.dx);
  // Radius scales linearly with nodeSize.
  const o0big = satelliteOffset(0, 20);
  assert.ok(Math.abs(o0big.dx - 20 * SATELLITE_RING_RADIUS) < 1e-9);
});

test('freeSatelliteSlot returns the smallest non-negative free slot', () => {
  assert.equal(freeSatelliteSlot([]), 0); // none used → 0
  assert.equal(freeSatelliteSlot([0, 1, 2]), 3); // packed → next
  assert.equal(freeSatelliteSlot([0, 2]), 1); // reuse the gap
  assert.equal(freeSatelliteSlot([1, 2]), 0); // 0 freed → reclaimed first
});

test('HoverLine snaps on first sample then low-passes, ignoring null targets', () => {
  const line = new HoverLine();
  assert.equal(line.value(), 0);
  line.update(null); // no bounds yet — stays uninitialised
  assert.equal(line.value(), 0);
  line.update(100); // first real sample snaps
  assert.equal(line.value(), 100);
  line.update(0); // then eases (HOVER_EASE = 0.06)
  assert.ok(Math.abs(line.value() - 94) < 1e-9);
  line.update(null); // null is a no-op
  assert.ok(Math.abs(line.value() - 94) < 1e-9);
});

test('HoverLine.update reports motion so a settled line lets the loop idle', () => {
  const line = new HoverLine();
  assert.equal(line.update(null), false); // no target → no motion
  assert.equal(line.update(100), true); // first sample snaps → moved
  assert.equal(line.update(0), true); // big step → still moving
  // Ease all the way in; eventually the per-frame step drops below REST_EPS and
  // update() reports rest, which is what releases the `agents` idle hold.
  let moved = true;
  for (let i = 0; i < 1000 && moved; i++) moved = line.update(0);
  assert.equal(moved, false);
  assert.ok(Math.abs(line.value()) < 0.5); // settled at (≈) the target
  assert.equal(line.update(null), false); // null stays a no-op once settled
});
