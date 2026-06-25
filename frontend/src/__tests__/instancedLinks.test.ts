import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeLinkSegments } from '../components/forceGraph/instancedLinks.ts';

// A fully-hydrated link writes its two real endpoints, source first.
test('hydrated link writes both endpoints in order', () => {
  const source = { x: 1, y: 2, z: 3 };
  const target = { x: 4, y: 5, z: 6 };
  const out = new Float32Array(6);
  writeLinkSegments([{ source, target }], out);
  assert.deepEqual([...out], [1, 2, 3, 4, 5, 6]);
});

// Regression: a link whose source is still an unhydrated id string must NOT be
// skipped — that left the source vertex at (0,0,0) against the hydrated target,
// rendering a stray line to the world origin. It must collapse to a degenerate
// (both-endpoints-equal) zero-length line at the hydrated endpoint.
test('unhydrated source collapses the segment to a zero-length line, not stale zeros', () => {
  const target = { x: 4, y: 5, z: 6 };
  // Pre-fill with the freshly-grown-buffer state (zeros) the bug rendered from.
  const out = new Float32Array(6); // already all zeros
  writeLinkSegments([{ source: 'src-id', target }], out);
  // Both vertices equal -> zero-length, invisible line.
  assert.deepEqual([...out.slice(0, 3)], [...out.slice(3, 6)], 'both vertices equal');
  // And specifically NOT [0,0,0, 4,5,6] (the stray origin->target line).
  assert.deepEqual([...out], [4, 5, 6, 4, 5, 6]);
});

// Symmetric case: unhydrated target collapses onto the hydrated source.
test('unhydrated target collapses the segment onto the hydrated source', () => {
  const source = { x: 7, y: 8, z: 9 };
  const out = new Float32Array(6);
  out.fill(99); // prove the helper overwrites stale data, never leaves it
  writeLinkSegments([{ source, target: 'tgt-id' }], out);
  assert.deepEqual([...out], [7, 8, 9, 7, 8, 9]);
});

// Neither endpoint hydrated -> degenerate at the origin (still invisible).
test('both endpoints unhydrated collapse to a zero-length line at the origin', () => {
  const out = new Float32Array(6);
  out.fill(99);
  writeLinkSegments([{ source: 'a', target: 'b' }], out);
  assert.deepEqual([...out], [0, 0, 0, 0, 0, 0]);
});

// Missing coords default to 0 (matches the original `?? 0` semantics).
test('missing node coords default to zero', () => {
  const out = new Float32Array(6);
  writeLinkSegments([{ source: {}, target: { x: 1 } }], out);
  assert.deepEqual([...out], [0, 0, 0, 1, 0, 0]);
});

// Multiple links pack consecutively; an unhydrated one in the middle stays
// degenerate without corrupting its neighbours' offsets.
test('writes consecutive links and keeps a mid-list degenerate segment isolated', () => {
  const out = new Float32Array(18);
  writeLinkSegments(
    [
      { source: { x: 0, y: 0, z: 0 }, target: { x: 1, y: 1, z: 1 } },
      { source: 'unhydrated', target: { x: 2, y: 2, z: 2 } },
      { source: { x: 3, y: 3, z: 3 }, target: { x: 4, y: 4, z: 4 } },
    ],
    out,
  );
  assert.deepEqual([...out], [
    0, 0, 0, 1, 1, 1, // first link, normal
    2, 2, 2, 2, 2, 2, // middle link, degenerate at the hydrated target
    3, 3, 3, 4, 4, 4, // last link, normal
  ]);
});
