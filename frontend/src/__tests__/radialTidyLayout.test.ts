import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRadialTidyLayout,
  tidyRingStep,
} from '../components/forceGraph/radialTidyLayout.ts';
import type { ScanResult, GraphNode } from '../api/types/scan.ts';

const ROOT = '/repo';

function dir(path: string): GraphNode {
  return { id: path, name: path, path, kind: 'dir' };
}
function file(path: string): GraphNode {
  return { id: path, name: path, path, kind: 'file' };
}

// /repo                         depth 0 (root)
//   /repo/a, /repo/b            depth 1
//     /repo/a/x                 depth 2
//       /repo/a/x/deep          depth 3  ← deepest dir
//         leaf.ts               depth 4  (file)
//     /repo/b/y                 depth 2
//       thing.ts                depth 3  (file)
function sample(): ScanResult {
  return {
    root: ROOT,
    nodes: [
      dir('/repo'),
      dir('/repo/a'),
      dir('/repo/b'),
      dir('/repo/a/x'),
      dir('/repo/b/y'),
      dir('/repo/a/x/deep'),
      file('/repo/a/x/deep/leaf.ts'),
      file('/repo/b/y/thing.ts'),
    ],
    links: [
      { source: '/repo', target: '/repo/a' },
      { source: '/repo', target: '/repo/b' },
      { source: '/repo/a', target: '/repo/a/x' },
      { source: '/repo/b', target: '/repo/b/y' },
      { source: '/repo/a/x', target: '/repo/a/x/deep' },
      { source: '/repo/a/x/deep', target: '/repo/a/x/deep/leaf.ts' },
      { source: '/repo/b/y', target: '/repo/b/y/thing.ts' },
    ],
  };
}

const OPTS = { spread: 1, linkDistance: 30, dagLevelDistance: 50 };

test('places a position for every node, with the root at the origin', () => {
  const pos = computeRadialTidyLayout(sample(), OPTS);
  assert.equal(pos.size, 8, 'one position per node');
  const root = pos.get('/repo')!;
  assert.ok(Math.hypot(root.x, root.z) < 1e-9, 'root sits at the origin (depth 0)');
});

test('radius grows strictly with directory depth', () => {
  const pos = computeRadialTidyLayout(sample(), OPTS);
  const r = (id: string) => Math.hypot(pos.get(id)!.x, pos.get(id)!.z);
  // depth 0 < depth 1 < depth 2 < depth 3 < depth 4
  assert.ok(r('/repo') < r('/repo/a'), 'depth 1 beyond root');
  assert.ok(r('/repo/a') < r('/repo/a/x'), 'depth 2 beyond depth 1');
  assert.ok(r('/repo/a/x') < r('/repo/a/x/deep'), 'depth 3 beyond depth 2');
  assert.ok(
    r('/repo/a/x/deep') < r('/repo/a/x/deep/leaf.ts'),
    'depth 4 (file) beyond depth 3',
  );
});

test('sibling subtrees occupy disjoint angular wedges (no tangle)', () => {
  const pos = computeRadialTidyLayout(sample(), OPTS);
  // Every node under /repo/a should share a half-plane distinct from /repo/b's.
  // Concretely: the angular span of subtree a and subtree b must not interleave.
  const ang = (id: string) => Math.atan2(pos.get(id)!.z, pos.get(id)!.x);
  const aSub = ['/repo/a', '/repo/a/x', '/repo/a/x/deep', '/repo/a/x/deep/leaf.ts'].map(ang);
  const bSub = ['/repo/b', '/repo/b/y', '/repo/b/y/thing.ts'].map(ang);
  const aMin = Math.min(...aSub), aMax = Math.max(...aSub);
  const bMin = Math.min(...bSub), bMax = Math.max(...bSub);
  // Disjoint ranges: one subtree's whole angular extent is below the other's.
  const disjoint = aMax <= bMin + 1e-9 || bMax <= aMin + 1e-9;
  assert.ok(disjoint, 'subtree a and subtree b do not share angular space');
});

test('a heavier subtree gets a proportionally wider angular wedge', () => {
  // Root with two children: one leaf, one dir holding 3 leaves.
  const data: ScanResult = {
    root: ROOT,
    nodes: [
      dir('/repo'),
      file('/repo/solo.ts'),
      dir('/repo/big'),
      file('/repo/big/1.ts'),
      file('/repo/big/2.ts'),
      file('/repo/big/3.ts'),
    ],
    links: [
      { source: '/repo', target: '/repo/solo.ts' },
      { source: '/repo', target: '/repo/big' },
      { source: '/repo/big', target: '/repo/big/1.ts' },
      { source: '/repo/big', target: '/repo/big/2.ts' },
      { source: '/repo/big', target: '/repo/big/3.ts' },
    ],
  };
  const pos = computeRadialTidyLayout(data, OPTS);
  // /repo/big spans 3/4 of the circle, so its three leaves fan across a wide
  // arc; the solo leaf gets the remaining 1/4. The angular spread of big's
  // leaves should exceed a quarter-circle's worth.
  const ang = (id: string) => Math.atan2(pos.get(id)!.z, pos.get(id)!.x);
  const bigLeaves = ['/repo/big/1.ts', '/repo/big/3.ts'].map(ang);
  const spread = Math.abs(bigLeaves[0] - bigLeaves[1]);
  assert.ok(spread > Math.PI / 4, 'the heavy subtree fans across a wide arc');
});

test('an empty scan yields an empty layout', () => {
  const empty: ScanResult = { root: ROOT, nodes: [], links: [] };
  assert.equal(computeRadialTidyLayout(empty, OPTS).size, 0);
  assert.equal(computeRadialTidyLayout(null, OPTS).size, 0);
});

test('a flat project (root + files, no nested dirs) still lays out radially', () => {
  const flat: ScanResult = {
    root: ROOT,
    nodes: [dir('/repo'), file('/repo/a.ts'), file('/repo/b.ts')],
    links: [
      { source: '/repo', target: '/repo/a.ts' },
      { source: '/repo', target: '/repo/b.ts' },
    ],
  };
  const pos = computeRadialTidyLayout(flat, OPTS);
  assert.equal(pos.size, 3);
  // The two files sit out on the first ring on opposite sides of the root.
  const a = pos.get('/repo/a.ts')!;
  const b = pos.get('/repo/b.ts')!;
  assert.ok(Math.hypot(a.x, a.z) > 0, 'file a is off the origin');
  assert.ok(Math.hypot(b.x, b.z) > 0, 'file b is off the origin');
});

test('tidyRingStep is floored at the DAG level distance', () => {
  // A tiny graph whose auto spacing would fall below the level distance is
  // clamped up so rings are never tighter than the vertical levels.
  const step = tidyRingStep(4, 8, { spread: 1, linkDistance: 30, dagLevelDistance: 50 });
  assert.equal(step, 50, 'clamped to dagLevelDistance');
});

test('tidyRingStep scales with node count and the spread multiplier', () => {
  const small = tidyRingStep(400, 5, OPTS);
  const big = tidyRingStep(4000, 5, OPTS);
  assert.ok(big > small, 'more nodes → wider rings (sqrt(N) scaling)');
  const wide = tidyRingStep(400, 5, { ...OPTS, spread: 2 });
  assert.ok(wide > small, 'a larger spread multiplier widens the rings');
});

test('a malformed cyclic input does not loop forever', () => {
  // Two dirs that point at each other (no real root). Should bail to empty
  // rather than hang.
  const cyclic: ScanResult = {
    root: ROOT,
    nodes: [dir('/repo/a'), dir('/repo/b')],
    links: [
      { source: '/repo/a', target: '/repo/b' },
      { source: '/repo/b', target: '/repo/a' },
    ],
  };
  const pos = computeRadialTidyLayout(cyclic, OPTS);
  assert.equal(pos.size, 0, 'no root → empty layout (no infinite loop)');
});

test('handles backslash (Windows) path-id separators', () => {
  const win: ScanResult = {
    root: 'C:\\repo',
    nodes: [dir('C:\\repo'), dir('C:\\repo\\a'), file('C:\\repo\\a\\f.ts')],
    links: [
      { source: 'C:\\repo', target: 'C:\\repo\\a' },
      { source: 'C:\\repo\\a', target: 'C:\\repo\\a\\f.ts' },
    ],
  };
  const pos = computeRadialTidyLayout(win, OPTS);
  assert.equal(pos.size, 3);
  const root = pos.get('C:\\repo')!;
  assert.ok(Math.hypot(root.x, root.z) < 1e-9, 'root at origin');
});
