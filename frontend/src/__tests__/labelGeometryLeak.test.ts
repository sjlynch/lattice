import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { GraphNode } from '../api/types/scan.ts';
import { DEFAULT_SETTINGS } from '../components/forceGraph/graphSettings.ts';
import type { FloatingLabelEntry } from '../components/forceGraph/floatingLabelSprite.ts';
import { spriteForLoc, locLabelRegistry } from '../components/forceGraph/locOverlay.ts';
import { spriteForHealth, healthLabelRegistry } from '../components/forceGraph/healthOverlay.ts';
import { applyNodeLabelState, labelsRegistry } from '../components/forceGraph/labelsOverlay.ts';
import { clearMetricLabelRegistry } from '../components/forceGraph/metricOverlayFactory.ts';
import {
  clearAllLabelRegistries,
  LABEL_TRIM_DELAY_MS,
} from '../components/forceGraph/hooks/refresh.ts';
import { installCanvasDocument, installManualTimers } from './domDoubles.ts';

const settings = { ...DEFAULT_SETTINGS, metricLabels: true };

function fileNode(name: string, metrics: Pick<GraphNode, 'loc' | 'health'> = {}): GraphNode {
  return { id: name, name, path: `/project/${name}`, kind: 'file', ext: '.ts', ...metrics };
}

type DisposeOwner = {
  addEventListener(type: 'dispose', listener: () => void): void;
  removeEventListener(type: 'dispose', listener: () => void): void;
};

function overlayFixture(t: TestContext) {
  // Label measurement is lazy, so static imports need no document shim.
  const restoreDocument = installCanvasDocument();
  const scene = new THREE.Scene();
  const removeListeners: (() => void)[] = [];
  t.after(() => {
    try {
      clearAllLabelRegistries();
    } finally {
      scene.clear();
      for (const remove of removeListeners) remove();
      removeListeners.length = 0;
      restoreDocument();
    }
  });

  function watchDisposals(...owners: DisposeOwner[]): number[] {
    const counts = owners.map(() => 0);
    owners.forEach((owner, i) => {
      const listener = () => { counts[i]++; };
      owner.addEventListener('dispose', listener);
      removeListeners.push(() => owner.removeEventListener('dispose', listener));
    });
    return counts;
  }

  function capture(entry: FloatingLabelEntry) {
    const material = entry.label.material;
    const texture = material.map;
    assert.ok(texture, 'the real owner built a textured label');
    return {
      entry, material, texture,
      // Geometry belongs to the entry; texture/material belong to its cache.
      disposals: watchDisposals(entry.line.geometry, texture, material),
    };
  }

  return { scene, watchDisposals, capture };
}

test('clearAllLabelRegistries releases real overlay entries and excess name-label resources', (t) => {
  const { scene, watchDisposals, capture } = overlayFixture(t);
  for (let i = 0; i < 2; i++) {
    const node = fileNode(`metric-${i}.ts`, { loc: 80 + i, health: 90 + i });
    scene.add(spriteForLoc(node, settings), spriteForHealth(node, settings));
  }
  // One past the production cap: all textures are live until the owner clears.
  for (let i = 0; i < 257; i++) {
    const root = new THREE.Group();
    scene.add(root);
    applyNodeLabelState(root, fileNode(`name-${i}.ts`), settings, 1, 1, true);
  }

  assert.equal(locLabelRegistry.size, 2);
  assert.equal(healthLabelRegistry.size, 2);
  assert.equal(labelsRegistry.size, 257);
  const loc = [...locLabelRegistry].map(capture);
  const health = [...healthLabelRegistry].map(capture);
  const names = [...labelsRegistry].map(capture);
  const all = [...loc, ...health, ...names];
  assert.equal(new Set(all.map(({ entry }) => entry.line.geometry)).size, all.length,
    'each connector owns a distinct geometry clone');
  for (const entries of [loc, health, names]) {
    assert.equal(entries[0].entry.line.material, entries[1].entry.line.material,
      'same-color connectors share their module-owned material');
  }
  const lineMaterials = [...new Set(all.map(({ entry }) => entry.line.material))];
  const lineDisposals = watchDisposals(...lineMaterials.flat());
  for (const { disposals, texture } of all) {
    assert.deepEqual(disposals, [0, 0, 0], 'mounted resources have not been disposed');
    assert.ok(texture.image.width > 0 && texture.image.height > 0);
  }

  clearAllLabelRegistries();

  for (const registry of [locLabelRegistry, healthLabelRegistry, labelsRegistry]) {
    assert.equal(registry.size, 0, 'the real blanket-clear empties every registry');
  }
  for (const { disposals } of all) assert.equal(disposals[0], 1);
  // Inspect captured resources now, with no subsequent label build to evict them.
  const evicted = names.filter(({ disposals }) => disposals[1] > 0);
  assert.ok(evicted.length > 0, 'name-registry releases make excess textures reclaimable');
  for (const { disposals, texture } of evicted) {
    assert.deepEqual(disposals, [1, 1, 1], 'eviction frees texture and paired material once');
    assert.equal(texture.image.width, 0);
    assert.equal(texture.image.height, 0);
  }

  clearAllLabelRegistries();

  for (const { disposals } of all) assert.equal(disposals[0], 1, 'empty clears do not double-free');
  for (const { disposals } of evicted) assert.deepEqual(disposals, [1, 1, 1]);
  assert.ok(lineDisposals.every((count) => count === 0), 'shared line materials remain usable');
});

test('metric registry owners balance shared label references across separate clears', (t) => {
  const { scene, capture } = overlayFixture(t);
  const sharedNode = fileNode('shared.ts', { loc: 84, health: 84 });
  scene.add(spriteForLoc(sharedNode, settings), spriteForHealth(sharedNode, settings));
  const loc = capture([...locLabelRegistry][0]);
  const health = capture([...healthLabelRegistry][0]);
  assert.equal(loc.texture, health.texture, 'equal metric text/color shares its texture');
  assert.equal(loc.material, health.material, 'the two sprites share the paired material');
  const dimensions = [loc.texture.image.width, loc.texture.image.height];
  assert.ok(dimensions.every((dimension) => dimension > 0));

  // Keep the overflow mounted in LOC, so its shared label is reclaimable only
  // after the health owner AND the LOC owner have each released their reference.
  for (let i = 0; i < 256; i++) {
    scene.add(spriteForLoc(fileNode(`burst-${i}.ts`, { loc: 2000 + i }), settings));
  }
  const burst = [...locLabelRegistry].slice(1).map(capture);
  assert.equal(burst.length, 256);
  assert.equal(new Set([loc.texture, ...burst.map(({ texture }) => texture)]).size, 257);

  clearMetricLabelRegistry(healthLabelRegistry);

  assert.equal(healthLabelRegistry.size, 0);
  assert.equal(locLabelRegistry.size, 257, 'the sibling registry remains live');
  assert.deepEqual(health.disposals, [1, 0, 0], 'only the cleared owner releases its geometry');
  assert.deepEqual(loc.disposals, [0, 0, 0], 'the sibling keeps shared resources alive');
  assert.deepEqual([loc.texture.image.width, loc.texture.image.height], dimensions);
  for (const { disposals } of burst) assert.deepEqual(disposals, [0, 0, 0]);

  clearMetricLabelRegistry(locLabelRegistry);

  assert.equal(locLabelRegistry.size, 0);
  assert.deepEqual(loc.disposals, [1, 1, 1], 'the final owner makes the old shared label evictable');
  assert.deepEqual(health.disposals, [1, 1, 1]);
  assert.equal(loc.texture.image.width, 0);
  assert.equal(loc.texture.image.height, 0);
  for (const { disposals } of burst) assert.equal(disposals[0], 1);

  clearMetricLabelRegistry(healthLabelRegistry);
  clearMetricLabelRegistry(locLabelRegistry);

  assert.deepEqual(loc.disposals, [1, 1, 1]);
  assert.deepEqual(health.disposals, [1, 1, 1]);
  for (const { disposals } of burst) assert.equal(disposals[0], 1, 'empty clears release no geometry again');
});

test('a batched clear keeps still-shown name labels for the rebuild, trims once after it, and teardown reclaims the rest', (t) => {
  const timers = installManualTimers();
  t.after(() => timers.restore());
  const { scene, capture } = overlayFixture(t);
  const nodes = Array.from({ length: 300 }, (_, i) => fileNode(`name-${i}.ts`));
  const mount = (count: number) => {
    for (const node of nodes.slice(0, count)) {
      const root = new THREE.Group();
      scene.add(root);
      applyNodeLabelState(root, node, settings, 1, 1, true);
    }
  };
  mount(300);
  const names = [...labelsRegistry].map(capture);
  assert.equal(names.length, 300);

  // clearLabelsAndRefresh / the structural swap, ahead of the library digest.
  clearAllLabelRegistries('batched');

  assert.equal(labelsRegistry.size, 0);
  for (const { disposals, texture } of names) {
    assert.deepEqual(disposals, [1, 0, 0], 'only the connector geometry is freed before the rebuild');
    assert.ok(texture.image.width > 0 && texture.image.height > 0);
  }
  assert.equal(timers.scheduled.length, 1, 'one deferred trim');
  assert.equal(timers.scheduled[0].delay, LABEL_TRIM_DELAY_MS);

  // The digest replaces the node objects; 250 of them still show their label.
  scene.clear();
  mount(250);
  const rebuilt = [...labelsRegistry];
  assert.equal(rebuilt.length, 250);
  rebuilt.forEach((entry, i) => {
    assert.equal(entry.label.material.map, names[i].texture, 'the rebuild re-acquired the cached texture');
  });
  for (const { disposals } of names) assert.equal(disposals[1], 0);

  timers.fireAll();

  // 300 cached, 250 in use: the trim evicts the 44 oldest free entries (cap 256).
  names.forEach(({ disposals }, i) => {
    assert.equal(disposals[1], i >= 250 && i < 294 ? 1 : 0, `name-${i}.ts`);
  });
  assert.equal(timers.scheduled.length, 0);

  // Graph teardown (`clearLabels`): nothing rebuilds, so no free entry stays.
  clearAllLabelRegistries();
  for (const { disposals, texture } of names) {
    assert.deepEqual(disposals.slice(1), [1, 1], 'teardown reclaims every released label once');
    assert.equal(texture.image.width * texture.image.height, 0);
  }
  assert.equal(timers.scheduled.length, 0, 'teardown schedules no trim');
});
