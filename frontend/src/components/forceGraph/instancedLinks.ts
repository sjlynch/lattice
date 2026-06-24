// Batched link rendering — collapses the library's one-`THREE.Line`-per-link
// into a single `THREE.LineSegments`.
//
// WHY. `three-forcegraph` creates an individual object per link (a `Line` when
// `linkWidth === 0`, a cylinder `Mesh` otherwise) and adds each to the scene —
// so a tree with E links costs E draw calls *every rendered frame*. The graph
// is a containment tree (E ≈ N), so links are ~half of all scene objects. While
// the engine is settled the per-link geometry isn't even being recomputed
// (`tickFrame` only updates positions while `engineRunning`), yet a plain camera
// orbit still re-submits all E+N draw calls per frame — the "rotating spikes CPU
// to ~85%" symptom. Batching the links into one object turns those E draw calls
// into 1.
//
// WHAT. We suppress the library's per-link objects by swapping `linkThreeObject`
// for an empty `Object3D` (no geometry → no draw call, and `tickFrame` skips its
// geometry update for a non-Line/Mesh object), and draw every visible link
// ourselves as a single `LineSegments` with two vertices per link. Positions are
// re-uploaded to the GPU only on frames where node positions actually moved —
// keyed off the shared `nodeMotionDriver` (engine tick OR a node drag) plus the
// one settling frame after — never during a pure orbit, so orbiting a settled
// graph is one static draw call. (An earlier version gated on the idle
// controller's `isEngineHot()`; that misses drags entirely. Gating on
// `onEngineTick` alone then missed a drag AFTER the layout settled — the engine
// refuses to re-tick below `d3AlphaMin`, so `onEngineTick` never fires; the
// drag's `onNodeDrag` callback in the motion driver covers that case.) Links
// carry no overlays and aren't pick targets (raycast
// disabled), so nothing else in the view depends on the per-link objects we
// remove. Flat 1px lines (the `linkWidth: 0` look); opt-in via the `batchedLinks`
// setting so the cylinder look stays available.

import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { createMotionSyncGate } from './motionSyncGate';
import { getIdleController } from './idleController';

type SimNode = { x?: number; y?: number; z?: number };
type SimLink = { source: SimNode | string; target: SimNode | string };

// The library stamps these accessors/methods onto the instance; the published
// types are partial, so reach them through a narrow cast.
type LinkGraph = {
  scene: () => THREE.Scene;
  graphData: () => { links: SimLink[] };
  linkVisibility: () => unknown;
  linkColor: () => unknown;
  linkOpacity: () => number;
  linkThreeObject: (v: unknown) => unknown;
};

// Flat 1px screen-space lines read heavier than the distance-attenuated lit
// cylinders they replace (constant width regardless of zoom, and unlit), so a
// dense graph turns into a bright web. Damp the configured link opacity for the
// batched look so the lines stay as subtle connectors.
const FLAT_LINE_OPACITY_SCALE = 0.55;

export type InstancedLinks = {
  setEnabled(on: boolean): void;
  /** Re-read the visible link set + resize the buffer (structural / filter change). */
  rebuild(): void;
  /** Per-frame hook (wire to the scene frame driver). Syncs positions while live. */
  onFrame(): void;
  dispose(): void;
};

// A unique empty object per link: no geometry (no draw call), and `tickFrame`'s
// position update no-ops for it (it's neither a Line nor a Mesh).
const emptyLinkObject = () => new THREE.Object3D();

// Build a THREE color the same way the library does (CSS string → sRGB-managed
// color) plus the separate alpha, so the batched material matches the per-link
// material's color/opacity exactly. `linkOpacity` multiplies the color's alpha.
function parseLinkColor(input: unknown): { css: string; alpha: number } {
  const str = typeof input === 'string' ? input : '';
  const m = str.match(/rgba?\(([^)]+)\)/i);
  if (!m) return { css: str || '#f0f0f0', alpha: 1 };
  const parts = m[1].split(',').map((s) => s.trim());
  const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
  return {
    css: `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`,
    alpha: Number.isFinite(a) ? a : 1,
  };
}

export function createInstancedLinks(graph: ForceGraph3DInstance): InstancedLinks {
  const g = graph as unknown as LinkGraph;
  const scene = g.scene();

  let enabled = false;
  let geometry: THREE.BufferGeometry | null = null;
  let material: THREE.LineBasicMaterial | null = null;
  let lineSegments: THREE.LineSegments | null = null;
  let positions = new Float32Array(0);
  // The visible links captured at the last rebuild, in buffer order.
  let links: SimLink[] = [];
  // Shared "should I re-upload positions this frame?" gate: engine-tick / drag
  // motion + one trailing settle frame + forced-dirty. See motionSyncGate.ts.
  const gate = createMotionSyncGate(graph);

  function visibleLinks(): SimLink[] {
    const all = g.graphData().links || [];
    const raw = g.linkVisibility();
    // Reuse the library's own visibility accessor (installed by useGraphFilter)
    // so the batched set matches what the per-link objects would have shown —
    // no duplicated hidden-ext / ghost predicate.
    if (typeof raw === 'function') {
      const fn = raw as (l: SimLink) => unknown;
      return all.filter((l) => !!fn(l));
    }
    return raw === undefined || !!raw ? all.slice() : [];
  }

  function ensureMaterial(): THREE.LineBasicMaterial {
    if (material) return material;
    const rawColor = g.linkColor();
    const colorValue =
      typeof rawColor === 'function'
        ? (rawColor as (l: SimLink | undefined) => unknown)(links[0])
        : rawColor;
    const { css, alpha } = parseLinkColor(colorValue);
    const opacity = alpha * (g.linkOpacity?.() ?? 1) * FLAT_LINE_OPACITY_SCALE;
    material = new THREE.LineBasicMaterial({
      color: new THREE.Color(css),
      transparent: opacity < 1,
      opacity,
      // Match the library: opaque lines write depth, translucent ones don't.
      depthWrite: opacity >= 1,
    });
    return material;
  }

  function syncPositions(): void {
    if (!geometry) return;
    const attr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    let w = 0;
    for (let i = 0; i < links.length; i++) {
      const s = links[i].source;
      const t = links[i].target;
      // Endpoints are hydrated to node refs after graphData() is applied; before
      // that they're still id strings — leave that segment at the origin until
      // the next rebuild, by which point hydration has caught up.
      if (typeof s === 'object' && typeof t === 'object') {
        positions[w] = s.x ?? 0;
        positions[w + 1] = s.y ?? 0;
        positions[w + 2] = s.z ?? 0;
        positions[w + 3] = t.x ?? 0;
        positions[w + 4] = t.y ?? 0;
        positions[w + 5] = t.z ?? 0;
      }
      w += 6;
    }
    attr.needsUpdate = true;
  }

  function rebuild(): void {
    if (!enabled) return;
    links = visibleLinks();
    const needed = links.length * 2 * 3;
    if (!geometry) geometry = new THREE.BufferGeometry();
    if (positions.length < needed) {
      positions = new Float32Array(needed);
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    }
    geometry.setDrawRange(0, links.length * 2);
    if (!lineSegments) {
      lineSegments = new THREE.LineSegments(geometry, ensureMaterial());
      // Match the library's link renderOrder (10) so links draw behind the
      // depth-test-disabled node sprites (renderOrder 12), as before.
      lineSegments.renderOrder = 10;
      // One object spanning the whole graph — never cull it as a unit (its
      // bounding sphere leaves the frustum long before the links do).
      lineSegments.frustumCulled = false;
      lineSegments.raycast = () => {};
      lineSegments.userData['lattice:batchedLinks'] = true;
      scene.add(lineSegments);
    }
    lineSegments.visible = true;
    // Sync the rebuilt buffer directly so the new lines paint this frame; the
    // gate's dirty flag is untouched (it's always clear here — only rebuild ever
    // set it, and it cleared it again the same call).
    syncPositions();
    // The loop may be paused (settled graph) when the user toggles this on or a
    // filter changes the set — wake a few frames so the rebuilt lines paint.
    getIdleController(graph)?.wakeForRefresh();
  }

  function onFrame(): void {
    if (!enabled || !lineSegments) return;
    if (gate.shouldSync()) syncPositions();
  }

  function setEnabled(on: boolean): void {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      // Replace the library's per-link Line/Mesh objects with empty Object3Ds
      // (no draw call) — we render all links as one LineSegments instead.
      g.linkThreeObject(emptyLinkObject);
      // Re-sync the buffer whenever node positions move (engine tick OR a drag —
      // incl. a drag after the layout has settled; see nodeMotionDriver).
      gate.attach();
      rebuild();
    } else {
      // Restore the library's default per-link line rendering.
      g.linkThreeObject(null);
      gate.detach();
      if (lineSegments) lineSegments.visible = false;
      getIdleController(graph)?.wakeForRefresh();
    }
  }

  function dispose(): void {
    gate.detach();
    if (lineSegments) {
      scene.remove(lineSegments);
      lineSegments = null;
    }
    geometry?.dispose();
    geometry = null;
    material?.dispose();
    material = null;
    positions = new Float32Array(0);
    links = [];
  }

  return { setEnabled, rebuild, onFrame, dispose };
}
