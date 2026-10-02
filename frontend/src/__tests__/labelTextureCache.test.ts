import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installCanvasDocument } from './domDoubles.ts';

// ---------------------------------------------------------------------------
// Headless DOM + GPU-dispose instrumentation.
//
// The label-texture path allocates real <canvas> elements and THREE textures.
// node:test runs without a DOM or WebGL, so we install the shared canvas/2D
// stub and record every Texture/Material `.dispose()` so the tests can assert
// exactly what got freed. labelTexture.ts creates its measure context lazily,
// so the stub only has to exist before the first build call — which is why the
// modules under test can be imported statically below.
// ---------------------------------------------------------------------------

// drawMeasuredLabelTexture measures exactly once per new canvas, so this
// counts rasterized labels (cache misses).
let canvasesDrawn = 0;
installCanvasDocument((t) => {
  canvasesDrawn++;
  return {
    actualBoundingBoxLeft: t.length * 4,
    actualBoundingBoxRight: t.length * 4,
    width: t.length * 8,
  };
});

const disposedTextures = new Set<object>();
const disposedMaterials = new Set<object>();

const origTextureDispose = THREE.Texture.prototype.dispose;
THREE.Texture.prototype.dispose = function (this: object) {
  disposedTextures.add(this);
  return origTextureDispose.call(this);
};
const origMaterialDispose = THREE.Material.prototype.dispose;
THREE.Material.prototype.dispose = function (this: object) {
  disposedMaterials.add(this);
  return origMaterialDispose.call(this);
};

// Static imports are safe: none touch the DOM at module-eval time.
import {
  buildMeasuredLabelTexture,
  createLabelTextureCache,
  deferLabelTextureTrim,
  disposeLabelTextureCache,
  releaseLabelTexture,
  trimLabelTextureCache,
  type LabelTextureOptions,
} from '../components/forceGraph/labelTexture.ts';
import { makeFloatingLabelSprite } from '../components/forceGraph/floatingLabelSprite.ts';
import { AgentOverlay } from '../components/forceGraph/agentOverlay.ts';

const OPTS = (maxEntries: number): LabelTextureOptions => ({
  font: 'bold 56px sans-serif',
  strokeWidth: 10,
  height: 96,
  padX: 20,
  minWidth: 96,
  maxEntries,
});

const SPRITE_CONFIG = { heightMultiplier: 1, maxScale: 100, aspectFallback: 3 };

test('eviction never disposes a texture still bound to a mounted sprite', () => {
  disposedTextures.clear();
  const cache = createLabelTextureCache();
  const opts = OPTS(256);

  // Mount 300 distinct labels at once — every build represents a live sprite,
  // so every entry is in use. The cache must grow past maxEntries rather than
  // evict (and dispose) any in-use texture.
  const textures: object[] = [];
  for (let i = 0; i < 300; i++) {
    textures.push(buildMeasuredLabelTexture(cache, `file${i}.ts`, '#ffffff', opts));
  }

  assert.equal(disposedTextures.size, 0, 'no in-use texture should be disposed');
  for (const t of textures) {
    assert.ok(!disposedTextures.has(t), 'a mounted texture was disposed');
  }
  // All 300 stayed cached (none evicted) — re-requesting one is a hit for the
  // exact same texture object.
  assert.equal(
    buildMeasuredLabelTexture(cache, 'file0.ts', '#ffffff', opts),
    textures[0],
  );
});

test('eviction reclaims released (free) entries and disposes texture + paired material', () => {
  disposedTextures.clear();
  disposedMaterials.clear();
  const cache = createLabelTextureCache();
  const opts = OPTS(4);

  // Build 4 distinct labels, each with a real sprite (→ a paired material).
  const built = [] as { tex: object; mat: object }[];
  for (let i = 0; i < 4; i++) {
    const tex = buildMeasuredLabelTexture(cache, `f${i}`, '#ffffff', opts);
    const sprite = makeFloatingLabelSprite(tex as any, 3, SPRITE_CONFIG);
    built.push({ tex, mat: sprite.material });
  }

  // f0 and f1 are no longer mounted; f2 and f3 still are.
  releaseLabelTexture(cache, built[0].tex as any);
  releaseLabelTexture(cache, built[1].tex as any);

  // 5th distinct build → cache at capacity → evict the oldest FREE entry (f0),
  // disposing its texture AND its paired material.
  buildMeasuredLabelTexture(cache, 'f4', '#ffffff', opts);
  assert.ok(disposedTextures.has(built[0].tex), 'oldest free texture evicted');
  assert.ok(disposedMaterials.has(built[0].mat), 'evicted texture\'s material freed');

  // 6th build → next oldest free is f1; the still-mounted f2/f3 are skipped.
  buildMeasuredLabelTexture(cache, 'f5', '#ffffff', opts);
  assert.ok(disposedTextures.has(built[1].tex), 'next free texture evicted');
  assert.ok(!disposedTextures.has(built[2].tex), 'in-use f2 never disposed');
  assert.ok(!disposedTextures.has(built[3].tex), 'in-use f3 never disposed');
});

// Regression: after a burst that grew the cache past its cap (every entry in
// use, e.g. a 2,000-file Alt band), releasing them all left the cache at its
// peak size for the rest of the session — each later miss evicted exactly one
// free entry and added one. The next miss must shrink it back under the cap.
test('a miss after a released over-cap burst evicts back down to maxEntries', () => {
  disposedTextures.clear();
  const cache = createLabelTextureCache();
  const opts = OPTS(4);
  const burst: object[] = [];
  for (let i = 0; i < 12; i++) {
    burst.push(buildMeasuredLabelTexture(cache, `burst${i}`, '#ffffff', opts));
  }
  assert.equal(cache.byKey.size, 12, 'in-use entries may exceed the cap');
  for (const t of burst) releaseLabelTexture(cache, t as any);

  buildMeasuredLabelTexture(cache, 'next', '#ffffff', opts);
  assert.ok(cache.byKey.size <= 4, `cache shrank to the cap (size ${cache.byKey.size})`);
  assert.equal(disposedTextures.size, 9, 'the oldest released textures were disposed');
  assert.ok(!disposedTextures.has(burst[11]), 'newest released entries stay cached');

  // A re-hit on a still-cached free entry takes it back out of the free set.
  const again = buildMeasuredLabelTexture(cache, 'burst11', '#ffffff', opts);
  assert.equal(again, burst[11]);
  for (let i = 0; i < 6; i++) buildMeasuredLabelTexture(cache, `more${i}`, '#ffffff', opts);
  assert.ok(!disposedTextures.has(burst[11]), 'a re-referenced entry is never evicted');
});

test('closing a large label overlay reclaims excess textures without another cache miss', () => {
  disposedTextures.clear();
  disposedMaterials.clear();
  const cache = createLabelTextureCache();
  const opts = OPTS(256);
  const burst = [];
  for (let i = 0; i < 2000; i++) {
    const tex = buildMeasuredLabelTexture(cache, `large-project-file-${i}.ts`, '#ffffff', opts);
    const sprite = makeFloatingLabelSprite(tex, 3, SPRITE_CONFIG);
    burst.push({ tex, mat: sprite.material });
  }
  assert.equal(cache.byKey.size, 2000, 'all mounted labels remain available');
  assert.equal(disposedTextures.size, 0);

  // Toggling Alt off (or leaving the project) releases the labels and then
  // does no further builds. Idle memory must return to the cache's cap now.
  for (const { tex } of burst) releaseLabelTexture(cache, tex);
  assert.equal(cache.byKey.size, 256, 'inactive cache immediately returns to its cap');
  assert.equal(cache.free.size, 256);
  assert.equal(cache.refs.size, 0);
  assert.equal(disposedTextures.size, 1744);
  assert.equal(disposedMaterials.size, 1744);
  for (const { tex, mat } of burst.slice(0, 1744)) {
    assert.ok(disposedTextures.has(tex), 'excess texture disposed');
    assert.ok(disposedMaterials.has(mat), 'paired material disposed');
    assert.equal(tex.image.width * tex.image.height, 0, 'evicted canvas pixels released');
  }
  for (const { tex } of burst.slice(1744)) {
    assert.ok(tex.image.width * tex.image.height > 0, 'cached labels keep their pixels');
  }
});

test('release-time eviction preserves labels still used by another sprite', () => {
  disposedTextures.clear();
  const cache = createLabelTextureCache();
  const opts = OPTS(4);
  const shared = buildMeasuredLabelTexture(cache, 'shared', '#ffffff', opts);
  assert.equal(buildMeasuredLabelTexture(cache, 'shared', '#ffffff', opts), shared);
  const burst = Array.from({ length: 12 }, (_, i) =>
    buildMeasuredLabelTexture(cache, `burst${i}`, '#ffffff', opts));

  releaseLabelTexture(cache, shared);
  for (const tex of burst) releaseLabelTexture(cache, tex);
  assert.equal(cache.byKey.size, 4, 'released overflow reclaimed');
  assert.ok(!disposedTextures.has(shared), 'the other sprite keeps its texture alive');
  assert.ok(shared.image.width * shared.image.height > 0, 'shared label pixels remain usable');
  assert.equal(cache.refs.get(cache.keyOf.get(shared)!), 1);
  // A duplicate teardown after eviction is harmless.
  releaseLabelTexture(cache, burst[0]);
  assert.equal(cache.byKey.size, 4);
});

test('cached label pixels survive reuse and are released only on eviction', () => {
  const cache = createLabelTextureCache();
  const opts = OPTS(1);
  const original = buildMeasuredLabelTexture(cache, 'original', '#ffffff', opts);
  const dimensions = [original.image.width, original.image.height];
  releaseLabelTexture(cache, original);
  assert.deepEqual([original.image.width, original.image.height], dimensions);

  const reused = buildMeasuredLabelTexture(cache, 'original', '#ffffff', opts);
  assert.equal(reused, original);
  assert.deepEqual([reused.image.width, reused.image.height], dimensions);
  releaseLabelTexture(cache, reused);

  const replacement = buildMeasuredLabelTexture(cache, 'replacement', '#ffffff', opts);
  assert.equal(original.image.width * original.image.height, 0, 'eviction frees native pixel storage');
  assert.ok(replacement.image.width * replacement.image.height > 0, 'new label remains drawable');
  releaseLabelTexture(cache, original);
  assert.ok(replacement.image.width * replacement.image.height > 0, 'late release cannot clear another label');
});

test('owner teardown releases all canvas pixels and the cache can be rebuilt', () => {
  const cache = createLabelTextureCache();
  const opts = OPTS(4);
  const active = buildMeasuredLabelTexture(cache, 'active', '#ffffff', opts);
  const inactive = buildMeasuredLabelTexture(cache, 'inactive', '#ffffff', opts);
  releaseLabelTexture(cache, inactive);

  disposeLabelTextureCache(cache);
  assert.equal(active.image.width * active.image.height, 0);
  assert.equal(inactive.image.width * inactive.image.height, 0);
  assert.equal(cache.byKey.size, 0);
  assert.equal(cache.refs.size, 0);
  assert.equal(cache.free.size, 0);
  disposeLabelTextureCache(cache);
  releaseLabelTexture(cache, active);

  const rebuilt = buildMeasuredLabelTexture(cache, 'active', '#ffffff', opts);
  assert.notEqual(rebuilt, active);
  assert.ok(rebuilt.image.width * rebuilt.image.height > 0, 'rebuilt label has fresh pixels');
  releaseLabelTexture(cache, active);
  assert.equal(cache.refs.get(cache.keyOf.get(rebuilt)!), 1);
});

// The refresh / structural-swap path: a blanket clear releases every mounted
// label, then the library's digest rebuilds the node objects. Trimming per
// release used to dispose every still-on-screen label past the cap and redraw
// each one as a brand-new canvas in the rebuild.
test('a batched clear + rebuild of 300 labels draws zero new canvases; the deferred trim restores the cap', () => {
  disposedTextures.clear();
  const cache = createLabelTextureCache();
  const opts = OPTS(256);
  const label = (i: number) => `file${i}.ts`;
  const mounted = Array.from({ length: 300 }, (_, i) =>
    buildMeasuredLabelTexture(cache, label(i), '#ffffff', opts));

  deferLabelTextureTrim(cache);
  for (const tex of mounted) releaseLabelTexture(cache, tex);
  assert.equal(cache.free.size, 300, 'every released entry is free');
  assert.equal(cache.byKey.size, 300, 'nothing is evicted while the batch is open');
  assert.equal(disposedTextures.size, 0);

  const drawnBefore = canvasesDrawn;
  for (let i = 0; i < 300; i++) {
    assert.equal(buildMeasuredLabelTexture(cache, label(i), '#ffffff', opts), mounted[i]);
  }
  assert.equal(canvasesDrawn - drawnBefore, 0, 'the rebuild drew no new canvas');
  assert.equal(cache.free.size, 0);
  for (const tex of mounted) {
    assert.ok(tex.image.width * tex.image.height > 0, 're-acquired labels keep their pixels');
  }

  trimLabelTextureCache(cache);
  assert.equal(disposedTextures.size, 0, 'every entry is in use again, so the trim evicts none');
  assert.equal(cache.byKey.size, 300);

  // The next refresh shows 200 of them plus 5 new labels (misses in the batch).
  deferLabelTextureTrim(cache);
  for (const tex of mounted) releaseLabelTexture(cache, tex);
  for (let i = 0; i < 200; i++) buildMeasuredLabelTexture(cache, label(i), '#ffffff', opts);
  for (let i = 0; i < 5; i++) buildMeasuredLabelTexture(cache, `new${i}.ts`, '#ffffff', opts);
  assert.equal(canvasesDrawn - drawnBefore, 5, 'only the new labels were drawn');
  assert.equal(disposedTextures.size, 0, 'misses inside the batch evict nothing');
  assert.equal(cache.byKey.size, 305);

  trimLabelTextureCache(cache);
  assert.equal(cache.byKey.size, 256, 'one deferred trim restores the cap');
  assert.equal(cache.free.size, 51);
  for (let i = 0; i < 300; i++) {
    assert.equal(disposedTextures.has(mounted[i]), i >= 200 && i < 249,
      `oldest free entries go first (label ${i})`);
  }

  // The trim ended the batch: a miss evicts immediately again.
  buildMeasuredLabelTexture(cache, 'after.ts', '#ffffff', opts);
  assert.ok(disposedTextures.has(mounted[249]), 'outside a batch a miss evicts at once');
  assert.equal(cache.byKey.size, 256);
});

test('the free-bytes budget evicts the oldest free entries first and never an in-use one', () => {
  disposedTextures.clear();
  // Equal-length texts draw equal canvases; measure one in a throwaway cache.
  const probe = buildMeasuredLabelTexture(createLabelTextureCache(), 'b0', '#ffffff', OPTS(256));
  const bytesEach = probe.image.width * probe.image.height * 4;
  assert.ok(bytesEach > 0);
  const opts = { ...OPTS(256), maxFreeBytes: 3 * bytesEach };
  const cache = createLabelTextureCache();
  const labels = Array.from({ length: 6 }, (_, i) =>
    buildMeasuredLabelTexture(cache, `b${i}`, '#ffffff', opts));
  assert.equal(cache.freeBytes, 0, 'in-use entries never count against the budget');

  for (const tex of labels.slice(0, 3)) releaseLabelTexture(cache, tex);
  assert.equal(cache.freeBytes, 3 * bytesEach);
  assert.equal(disposedTextures.size, 0, 'exactly at the budget: nothing evicted');

  releaseLabelTexture(cache, labels[3]);
  assert.ok(disposedTextures.has(labels[0]), 'the oldest free entry goes first');
  assert.equal(disposedTextures.size, 1);
  assert.equal(cache.freeBytes, 3 * bytesEach);
  assert.equal(labels[0].image.width * labels[0].image.height, 0, 'its pixels are released');

  // A re-hit takes the entry, and its bytes, out of the free set.
  assert.equal(buildMeasuredLabelTexture(cache, 'b1', '#ffffff', opts), labels[1]);
  assert.equal(cache.freeBytes, 2 * bytesEach);

  releaseLabelTexture(cache, labels[4]);
  assert.equal(disposedTextures.size, 1);
  // b1 is now the NEWEST free entry, so b2 is the one that goes.
  releaseLabelTexture(cache, labels[1]);
  assert.ok(disposedTextures.has(labels[2]));
  assert.ok(!disposedTextures.has(labels[1]), 'a re-freed entry counts as newest');
  assert.equal(cache.freeBytes, 3 * bytesEach);
  assert.ok(!disposedTextures.has(labels[5]), 'the in-use entry is never disposed');
  assert.ok(labels[5].image.width * labels[5].image.height > 0);
  assert.equal(cache.byKey.size, 4);
});

test('a teardown trim reclaims every free entry and never touches refcount > 0', () => {
  disposedTextures.clear();
  const cache = createLabelTextureCache();
  const opts = OPTS(256);
  const live = buildMeasuredLabelTexture(cache, 'live', '#ffffff', opts);
  const shared = buildMeasuredLabelTexture(cache, 'shared', '#ffffff', opts);
  assert.equal(buildMeasuredLabelTexture(cache, 'shared', '#ffffff', opts), shared);
  const gone = Array.from({ length: 5 }, (_, i) =>
    buildMeasuredLabelTexture(cache, `gone${i}`, '#ffffff', opts));

  // Left over from a batched clear whose rebuild didn't re-acquire them.
  deferLabelTextureTrim(cache);
  for (const tex of gone) releaseLabelTexture(cache, tex);
  releaseLabelTexture(cache, shared);
  assert.equal(disposedTextures.size, 0);

  trimLabelTextureCache(cache, 0);
  assert.equal(cache.trimDeferred, false, 'the trim ends the batch');
  assert.equal(cache.free.size, 0, 'no free entry survives teardown');
  assert.equal(cache.freeBytes, 0);
  assert.equal(cache.byKey.size, 2);
  for (const tex of gone) assert.ok(disposedTextures.has(tex));
  for (const tex of [live, shared]) {
    assert.ok(!disposedTextures.has(tex), 'an entry with refcount > 0 is never disposed');
    assert.ok(tex.image.width * tex.image.height > 0);
  }
  assert.equal(cache.refs.get(cache.keyOf.get(shared)!), 1);
});

test('AgentOverlay.destroy disposes agent label textures + materials', () => {
  disposedTextures.clear();
  disposedMaterials.clear();

  const scene = new THREE.Scene();
  const nodes = [
    { id: 'a', path: 'src/a.ts', x: 0, y: 0, z: 0 },
    { id: 'b', path: 'src/b.ts', x: 10, y: 5, z: 0 },
  ];
  const graph: any = {
    scene: () => scene,
    graphData: () => ({ nodes, links: [] }),
  };

  const overlay = new AgentOverlay(graph, 4);
  overlay.setAgents([{ taskId: 't1', color: '#ff0000' }], graph);
  overlay.addActivity('t1', 'src/a.ts', 'start', 1000);
  // A render tick builds the agent's file-label sprite (→ a cached texture).
  overlay.tick(1000, graph, false);

  // Find the label sprite: its texture is a MeasuredLabelTexture (has _aspect),
  // unlike the Claude node's disc texture.
  let labelTex: any = null;
  let labelMat: any = null;
  scene.traverse((obj: any) => {
    if (obj.isSprite && obj.material?.map?._aspect !== undefined) {
      labelTex = obj.material.map;
      labelMat = obj.material;
    }
  });
  assert.ok(labelTex, 'agent label texture exists after activity + tick');
  assert.ok(!disposedTextures.has(labelTex), 'label texture not disposed while mounted');

  overlay.destroy(graph);

  assert.ok(disposedTextures.has(labelTex), 'destroy disposes the agent label texture');
  assert.ok(disposedMaterials.has(labelMat), 'destroy disposes the paired material');
  assert.equal(labelTex.image.width * labelTex.image.height, 0, 'destroy frees native canvas pixels');
});
