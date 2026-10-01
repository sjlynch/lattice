import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { DEFAULT_SETTINGS } from '../components/forceGraph/graphSettings.ts';
import {
  configureSelectionGlow,
  resetHaloPulse,
  setNodeHalo,
  updateHaloPulse,
} from '../components/forceGraph/halo.ts';
import {
  glowMaterial,
  peekGlowMaterial,
  peekRingMaterial,
  RING_BASE_COLOR,
  ringMaterial,
} from '../components/forceGraph/haloResources.ts';
import { rebuildSelectionHalos } from '../components/forceGraph/selectionHaloSync.ts';
import { installCanvasDocument } from './domDoubles.ts';

type SharedResources = {
  ring: THREE.SpriteMaterial;
  ringMap: THREE.CanvasTexture;
  glow: THREE.SpriteMaterial;
  glowMap: THREE.CanvasTexture;
};

// Mirror the existing scene tag; no cache-reset or inspection API is needed.
function haloFor(root: THREE.Group): THREE.Group {
  const halo = root.children.find((child) => child.userData['lattice:halo']);
  assert.ok(halo instanceof THREE.Group, 'selected root has a halo group');
  assert.equal(halo.parent, root);
  return halo;
}

function haloSprites(halo: THREE.Group) {
  assert.equal(halo.children.length, 2, 'one ring and one glow per halo');
  const [ring, glow] = halo.children;
  assert.ok(ring instanceof THREE.Sprite);
  assert.ok(glow instanceof THREE.Sprite);
  return { ring, glow };
}

// Await the three subtests in order: the first must see the module's untouched
// lazy singletons. Imports above never construct a halo or call a resource getter.
test('selection halos borrow two bounded, module-owned resource pairs', async (t) => {
  const restoreDocument = installCanvasDocument();
  const createElement = t.mock.method(document, 'createElement');
  const scene = new THREE.Scene();
  const roots: THREE.Group[] = [];
  const removeListeners: (() => void)[] = [];
  const disposals = [0, 0, 0, 0];
  let shared: SharedResources | undefined;

  t.after(() => {
    try {
      for (const root of roots) {
        setNodeHalo(root, false, 0);
        root.clear();
      }
      scene.clear();
      configureSelectionGlow({
        strength: DEFAULT_SETTINGS.selectionGlowStrength,
        scale: DEFAULT_SETTINGS.selectionGlowScale,
      });
      resetHaloPulse();
    } finally {
      for (const remove of removeListeners) remove();
      createElement.mock.restore();
      restoreDocument();
    }
  });

  function fixture(baseSize: number) {
    const root = new THREE.Group();
    const body = new THREE.Object3D();
    root.add(body);
    scene.add(root);
    roots.push(root);
    return { root, body, baseSize };
  }

  function assertSharedHalo(root: THREE.Group) {
    assert.ok(shared);
    const halo = haloFor(root);
    const { ring, glow } = haloSprites(halo);
    assert.equal(ring.material, shared.ring);
    assert.equal(ring.material.map, shared.ringMap);
    assert.equal(glow.material, shared.glow);
    assert.equal(glow.material.map, shared.glowMap);
    return { halo, ring, glow };
  }

  function assertResourceBudget() {
    assert.ok(shared);
    assert.deepEqual(createElement.mock.calls.map(({ arguments: args }) => args[0]),
      ['canvas', 'canvas'], 'selection size, toggles and rebuilds allocate only two canvases');
    assert.equal(ringMaterial(), shared.ring);
    assert.equal(peekRingMaterial(), shared.ring);
    assert.equal(glowMaterial(), shared.glow);
    assert.equal(peekGlowMaterial(), shared.glow);
    assert.equal(shared.ring.map, shared.ringMap);
    assert.equal(shared.glow.map, shared.glowMap);
    assert.deepEqual(disposals, [0, 0, 0, 0], 'borrowed materials and maps stay alive');
  }

  await t.test('pulse and reset before the first halo allocate nothing', () => {
    assert.equal(peekRingMaterial(), null);
    assert.equal(peekGlowMaterial(), null);
    for (const nowMs of [0, 350, 825, 2200]) {
      updateHaloPulse(nowMs);
      resetHaloPulse();
      assert.equal(peekRingMaterial(), null);
      assert.equal(peekGlowMaterial(), null);
      assert.equal(createElement.mock.callCount(), 0);
    }
  });

  await t.test('multiple roots and repeated toggles borrow the same resources', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => fixture(6 + i));
    const first = nodes[0];
    setNodeHalo(first.root, true, first.baseSize);
    const { ring, glow } = haloSprites(haloFor(first.root));
    assert.ok(ring.material.map instanceof THREE.CanvasTexture);
    assert.ok(glow.material.map instanceof THREE.CanvasTexture);
    shared = {
      ring: ring.material, ringMap: ring.material.map,
      glow: glow.material, glowMap: glow.material.map,
    };
    assert.notEqual(shared.ring, shared.glow);
    assert.notEqual(shared.ringMap, shared.glowMap);
    assert.equal(createElement.mock.callCount(), 2);
    assert.equal(shared.ringMap.image, createElement.mock.calls[0].result);
    assert.equal(shared.glowMap.image, createElement.mock.calls[1].result);

    [shared.ring, shared.ringMap, shared.glow, shared.glowMap].forEach((owner, i) => {
      const listener = () => { disposals[i]++; };
      owner.addEventListener('dispose', listener);
      removeListeners.push(() => owner.removeEventListener('dispose', listener));
    });

    for (const { root, body, baseSize } of nodes) {
      setNodeHalo(root, true, baseSize);
      const { halo } = assertSharedHalo(root);
      setNodeHalo(root, true, baseSize);
      assert.equal(haloFor(root), halo, 'selecting an already-selected root is idempotent');
      assert.deepEqual(root.children, [body, halo]);
      assertResourceBudget();
    }

    const removed = haloFor(first.root);
    const sibling = haloFor(nodes[1].root);
    setNodeHalo(first.root, false, first.baseSize);
    assert.equal(removed.parent, null, 'deselection detaches the halo group');
    assert.deepEqual(first.root.children, [first.body]);
    assert.equal(first.body.parent, first.root, 'unrelated child remains attached');
    assert.equal(first.root.parent, scene);
    assert.equal(haloFor(nodes[1].root), sibling, 'still-selected sibling is untouched');
    assertSharedHalo(nodes[1].root);
    assertResourceBudget();
    setNodeHalo(first.root, true, first.baseSize);
    assert.notEqual(haloFor(first.root), removed);

    for (let round = 0; round < 6; round++) {
      for (const { root, body, baseSize } of nodes) {
        const previous = haloFor(root);
        setNodeHalo(root, false, baseSize);
        setNodeHalo(root, false, baseSize);
        assert.equal(previous.parent, null);
        assert.deepEqual(root.children, [body]);
        assertResourceBudget();

        setNodeHalo(root, true, baseSize);
        const { halo } = assertSharedHalo(root);
        assert.notEqual(halo, previous, 'reselection builds a new group with borrowed resources');
        setNodeHalo(root, true, baseSize);
        assert.equal(haloFor(root), halo);
        assert.deepEqual(root.children, [body, halo]);
        assertResourceBudget();
      }
    }

    for (const { root, body, baseSize } of nodes) {
      setNodeHalo(root, false, baseSize);
      assert.deepEqual(root.children, [body]);
    }
    assertResourceBudget(); // Clearing the entire selection also preserves the singletons.
  });

  await t.test('glow-scale rebuilds replace only selected halos and reuse resources', () => {
    assert.ok(shared);
    const settings = { ...DEFAULT_SETTINGS, fileNodeSize: 6, dirNodeSize: 11 };
    const mounted = [
      { id: 'selected-file', kind: 'file' as const, ...fixture(settings.fileNodeSize) },
      { id: 'selected-dir', kind: 'dir' as const, ...fixture(settings.dirNodeSize) },
      { id: 'unselected-file', kind: 'file' as const, ...fixture(settings.fileNodeSize) },
    ];
    const nodes = mounted.map(({ id, kind, root }) => ({
      id, name: id, path: `/project/${id}`, kind, __threeObj: root,
    }));
    const graph = {
      graphData: () => ({ nodes, links: [] }),
      refresh: () => { assert.fail('halo rebuild must not refresh the whole graph'); },
    } as unknown as ForceGraph3DInstance;
    const selected = new Set(['selected-file', 'selected-dir']);
    const selectedRoots = mounted.slice(0, 2);
    const unselected = mounted[2];
    const untouchedChildren = [...unselected.root.children];

    for (const { root, baseSize } of selectedRoots) {
      setNodeHalo(root, true, baseSize);
      const { glow } = assertSharedHalo(root);
      assert.deepEqual(glow.scale.toArray(),
        [baseSize * DEFAULT_SETTINGS.selectionGlowScale, baseSize * DEFAULT_SETTINGS.selectionGlowScale, 1]);
    }

    for (const scale of [0.75, 2.5, 1.25, 3]) {
      const previous = selectedRoots.map(({ root }) => assertSharedHalo(root));
      configureSelectionGlow({ strength: 0.6, scale });
      rebuildSelectionHalos(graph, selected, settings);

      selectedRoots.forEach(({ root, body, baseSize }, i) => {
        const { halo, ring, glow } = assertSharedHalo(root);
        assert.notEqual(halo, previous[i].halo);
        assert.equal(previous[i].halo.parent, null, 'old halo is detached on rebuild');
        assert.deepEqual(root.children, [body, halo]);
        assert.equal(body.parent, root);
        assert.equal(root.parent, scene);
        assert.deepEqual(glow.scale.toArray(), [baseSize * scale, baseSize * scale, 1]);
        assert.deepEqual(ring.scale.toArray(), previous[i].ring.scale.toArray());
      });
      assert.deepEqual(unselected.root.children, untouchedChildren);
      assert.equal(unselected.body.parent, unselected.root);
      assert.equal(unselected.root.parent, scene);
      assertResourceBudget();

      updateHaloPulse(350);
      assert.ok(shared.glow.opacity > 0, 'pulse animates the existing shared glow');
      assert.equal(shared.ring.color.equals(RING_BASE_COLOR), false);
      assertResourceBudget();
      resetHaloPulse();
      assert.equal(shared.glow.opacity, 0);
      assert.ok(shared.ring.color.equals(RING_BASE_COLOR));
      for (const { root } of selectedRoots) assertSharedHalo(root);
      assertResourceBudget();
    }
  });
});
