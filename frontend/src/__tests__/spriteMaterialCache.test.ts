import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import {
  createSpriteMaterialCache,
  disposeSharedGraphResources,
} from '../components/forceGraph/spriteMaterialCache.ts';
import {
  glowMaterial,
  peekGlowMaterial,
  peekRingMaterial,
  ringMaterial,
} from '../components/forceGraph/haloResources.ts';
import { installCanvasDocument } from './domDoubles.ts';

type DisposeTarget = { addEventListener(type: 'dispose', listener: () => void): void };

// Counts three `dispose` events, the signal a renderer's listener reacts to.
function countDisposals(...owners: DisposeTarget[]) {
  const counts = owners.map(() => 0);
  owners.forEach((owner, i) => owner.addEventListener('dispose', () => { counts[i]++; }));
  return counts;
}

function spriteMaterial(): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({ map: new THREE.Texture() });
}

test('get builds one entry per key and peek never builds', () => {
  const cache = createSpriteMaterialCache<string>();
  let built = 0;
  const create = () => {
    built++;
    return spriteMaterial();
  };
  assert.equal(cache.peek('#f00'), undefined);
  assert.equal(built, 0);

  const red = cache.get('#f00', create);
  assert.equal(cache.get('#f00', create), red);
  assert.equal(cache.peek('#f00'), red);
  const blue = cache.get('#00f', create);
  assert.notEqual(blue, red);
  assert.equal(built, 2);
});

test('disposeAll disposes each material and its map once, then empties the cache', () => {
  const cache = createSpriteMaterialCache<string>();
  const red = cache.get('#f00', spriteMaterial);
  const blue = cache.get('#00f', spriteMaterial);
  // A material without a map is disposed too.
  const plain = cache.get('plain', () => new THREE.SpriteMaterial());
  const disposals = countDisposals(red, red.map!, blue, blue.map!, plain);

  cache.disposeAll();
  assert.deepEqual(disposals, [1, 1, 1, 1, 1]);
  assert.equal(cache.peek('#f00'), undefined);
  assert.equal(cache.peek('#00f'), undefined);
  assert.equal(cache.peek('plain'), undefined);

  cache.disposeAll();
  assert.deepEqual(disposals, [1, 1, 1, 1, 1], 'a second disposeAll is a no-op');
  // The disposed source stays intact: a late holder can still re-upload it.
  assert.ok(red.map instanceof THREE.Texture);
});

test('after disposeAll, get builds a fresh entry', () => {
  const cache = createSpriteMaterialCache<'ghost'>();
  const before = cache.get('ghost', spriteMaterial);
  cache.disposeAll();
  const after = cache.get('ghost', spriteMaterial);
  assert.notEqual(after, before);
  assert.equal(cache.get('ghost', spriteMaterial), after);
  assert.equal(cache.peek('ghost'), after);
});

test('disposeAll on an empty cache is safe', () => {
  const cache = createSpriteMaterialCache<string>();
  assert.doesNotThrow(() => cache.disposeAll());
  assert.doesNotThrow(() => cache.disposeAll());
});

test('disposeSharedGraphResources disposes every cache once and keeps the halo singletons', (t) => {
  const restoreDocument = installCanvasDocument();
  t.after(restoreDocument);

  // Before any halo exists, teardown disposes nothing and allocates nothing.
  assert.doesNotThrow(disposeSharedGraphResources);
  assert.equal(peekRingMaterial(), null);
  assert.equal(peekGlowMaterial(), null);

  const sprites = createSpriteMaterialCache<string>();
  const rings = createSpriteMaterialCache<string>();
  const sprite = sprites.get('ts', spriteMaterial);
  const ring = rings.get('#0f0', spriteMaterial);
  const halo = { ring: ringMaterial(), glow: glowMaterial() };
  const disposals = countDisposals(
    sprite, sprite.map!, ring, ring.map!,
    halo.ring, halo.ring.map!, halo.glow, halo.glow.map!,
  );

  disposeSharedGraphResources();
  assert.deepEqual(disposals, [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(sprites.peek('ts'), undefined);
  assert.equal(rings.peek('#0f0'), undefined);
  // Halo JS objects live for the module lifetime; only the GPU side is released.
  assert.equal(peekRingMaterial(), halo.ring);
  assert.equal(peekGlowMaterial(), halo.glow);
  assert.equal(ringMaterial(), halo.ring);
  assert.equal(glowMaterial(), halo.glow);

  // A second teardown finds the caches empty and re-disposes nothing of theirs.
  disposeSharedGraphResources();
  assert.deepEqual(disposals.slice(0, 4), [1, 1, 1, 1]);
});

test('one failing cache cannot stop the others from being disposed', () => {
  const failure = new Error('dispose failed');
  const failing = createSpriteMaterialCache<string>();
  const healthy = createSpriteMaterialCache<string>();
  failing.get('bad', () => {
    const material = spriteMaterial();
    material.dispose = () => { throw failure; };
    return material;
  });
  const good = healthy.get('good', spriteMaterial);
  const disposals = countDisposals(good, good.map!);

  assert.throws(disposeSharedGraphResources, (error) => error === failure);
  assert.deepEqual(disposals, [1, 1]);
  assert.equal(healthy.peek('good'), undefined);
  assert.equal(failing.peek('bad'), undefined, 'emptied before disposing');
  assert.doesNotThrow(disposeSharedGraphResources);
});
