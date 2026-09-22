import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScanResult } from '../api';
import { depthMapStructuralKey } from '../components/forceGraph/depthMap.ts';

// The key is FNV-1a over the root + node ids with a '/' separator byte after
// each entry. It used a float multiply (`h * prime`, up to ~2^56) that rounded
// away the product's low bits, so it wasn't FNV-1a and its low bits were
// heavily biased toward zero. Pin it to a reference 32-bit implementation.

function referenceKey(root: string, ids: string[]): string {
  let h = 0x811c9dc5;
  for (const s of [root, ...ids]) {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ 0x2f, 0x01000193) >>> 0;
  }
  return `${ids.length}:${h}`;
}

function scan(root: string, ids: string[]): ScanResult {
  return {
    root,
    nodes: ids.map((id) => ({ id, path: id, name: id, kind: 'file' })),
    links: [],
  } as unknown as ScanResult;
}

test('matches a reference 32-bit FNV-1a over root + ids', () => {
  const ids = ['C:/p/src/a.ts', 'C:/p/src/b.ts', 'C:/p/README.md'];
  assert.equal(depthMapStructuralKey(scan('C:/p', ids)), referenceKey('C:/p', ids));
  assert.equal(depthMapStructuralKey(scan('', [])), referenceKey('', []));
});

test('low bits are not biased toward zero', () => {
  let lowZero = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) {
    const h = Number(depthMapStructuralKey(scan('/r', [`/r/file${i}.ts`])).split(':')[1]);
    if ((h & 7) === 0) lowZero++;
  }
  // Uniform bits give ~1/8; the float-multiply version gave ~70%.
  assert.ok(lowZero < n * 0.2, `low-3-bit zero rate ${lowZero}/${n}`);
});

test('separator keeps ["ab","c"] and ["a","bc"] distinct', () => {
  assert.notEqual(
    depthMapStructuralKey(scan('', ['ab', 'c'])),
    depthMapStructuralKey(scan('', ['a', 'bc'])),
  );
});
