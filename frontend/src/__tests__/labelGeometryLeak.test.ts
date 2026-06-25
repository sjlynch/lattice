import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  disposeAndClearRegistry,
  disposeLabelEntry,
  makeConnectorLine,
  type FloatingLabelEntry,
} from '../components/forceGraph/floatingLabelSprite.ts';

// Regression: holding/pinning the LOC (`z`) or health (`h`) overlay populates a
// registry with one entry per FILE node, each owning a per-line CLONE of the
// connector geometry template (the one GPU buffer the entry solely owns). Every
// graph.refresh() while active replaces each node's THREE object, and the
// library does NOT traverse-dispose the replaced objects — so the old registry's
// cloned geometries are orphaned. The refresh paths used to drop them with a
// bare Set.clear(), stranding N BufferGeometry GPU buffers per refresh.
// disposeAndClearRegistry must dispose each entry's geometry before clearing.
//
// We replicate createMetricOverlaySpriteFactory's `registry.add({ label, line })`
// directly rather than importing it, because that module's labelTexture
// dependency touches `document` at load time (no DOM under node:test).
function buildOverlayRegistry(fileNodeCount: number): {
  registry: Set<FloatingLabelEntry>;
  disposeCounts: number[];
} {
  const registry = new Set<FloatingLabelEntry>();
  const disposeCounts: number[] = [];
  for (let i = 0; i < fileNodeCount; i++) {
    const line = makeConnectorLine({ color: '#7ed884', labelY: 100, opacity: 0.9 });
    const label = new THREE.Sprite();
    const idx = disposeCounts.push(0) - 1;
    const realDispose = line.geometry.dispose.bind(line.geometry);
    line.geometry.dispose = () => {
      disposeCounts[idx]++;
      realDispose();
    };
    registry.add({ label, line });
  }
  return { registry, disposeCounts };
}

test('disposeAndClearRegistry disposes exactly one cloned geometry per overlay entry, then empties the set', () => {
  const N = 7;
  const { registry, disposeCounts } = buildOverlayRegistry(N);
  assert.equal(registry.size, N);

  disposeAndClearRegistry(registry);

  assert.equal(registry.size, 0, 'registry emptied after clear');
  for (const c of disposeCounts) {
    assert.equal(c, 1, 'each entry geometry disposed exactly once (no double-free, no leak)');
  }
  assert.equal(
    disposeCounts.reduce((a, b) => a + b, 0),
    N,
    'exactly N geometry disposals per overlay refresh',
  );
});

test('each overlay entry owns its own cloned connector geometry but shares the line material', () => {
  const a = makeConnectorLine({ color: '#f57878', labelY: 100, opacity: 0.9 });
  const b = makeConnectorLine({ color: '#f57878', labelY: 100, opacity: 0.9 });
  // Distinct geometry clones — the repulsion step mutates each line's upper
  // endpoint per-frame, so they can't be one shared instance (hence the leak).
  assert.notEqual(a.geometry, b.geometry);
  // ...but the LineBasicMaterial is module-cached per (color, opacity).
  assert.equal(a.material, b.material);
});

test('disposeAndClearRegistry leaves the shared, module-owned line material untouched', () => {
  const registry = new Set<FloatingLabelEntry>();
  const line = makeConnectorLine({ color: '#f5d76e', labelY: 100, opacity: 0.9 });
  const material = line.material as THREE.LineBasicMaterial;
  let materialDisposed = 0;
  const realMatDispose = material.dispose.bind(material);
  material.dispose = () => {
    materialDisposed++;
    realMatDispose();
  };
  registry.add({ label: new THREE.Sprite(), line });

  disposeAndClearRegistry(registry);

  assert.equal(materialDisposed, 0, 'shared material/texture/template must never be disposed per-node');
});

test('disposeLabelEntry frees only the connector geometry', () => {
  const line = makeConnectorLine({ color: '#7ed884', labelY: 100, opacity: 0.7 });
  let geomDisposed = 0;
  const realDispose = line.geometry.dispose.bind(line.geometry);
  line.geometry.dispose = () => {
    geomDisposed++;
    realDispose();
  };

  disposeLabelEntry({ label: new THREE.Sprite(), line });

  assert.equal(geomDisposed, 1);
});

test('disposeAndClearRegistry on an empty registry is a no-op', () => {
  const registry = new Set<FloatingLabelEntry>();
  disposeAndClearRegistry(registry);
  assert.equal(registry.size, 0);
});
