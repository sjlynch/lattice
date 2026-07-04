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
import {
  capacityWithSlack,
  visibilityPredicate,
  wakeInstancedRefresh,
} from './instancedBatching';
import { LINK_RENDER_ORDER } from './renderOrders';
import { writeVertexTriple } from './matrixBuffer';

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

// Extra link slots reserved when the position buffer has to grow, so a few
// added/un-hidden links don't force a reallocation every rebuild. Mirrors
// instancedNodes' CAPACITY_SLACK — makes the buffer-replacement (and the GPU
// free below) rare rather than per-growth.
const CAPACITY_SLACK = 64;

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

// Write each link's two endpoint vertices (6 floats per link) into `out`, in
// `links` order, starting at `out[0]`. Exported for the regression test.
//
// Endpoints are hydrated from id strings to node refs only after graphData() is
// applied. While a link's source/target is still a string, we must NOT skip its
// write: on a freshly-grown buffer those slots are zero, but the draw range
// still includes the segment, so a stale (0,0,0) vertex against the hydrated
// partner renders a stray line converging on the world origin for a frame or
// two. Instead, collapse a not-yet-hydrated segment to a DEGENERATE (both
// vertices equal) line — reuse whichever endpoint is hydrated for both vertices,
// or the origin if neither is — so it draws as an invisible zero-length line
// until the next rebuild lands the hydrated refs.
export function writeLinkSegments(links: SimLink[], out: Float32Array): void {
  let w = 0;
  for (let i = 0; i < links.length; i++) {
    const s = links[i].source;
    const t = links[i].target;
    const so = typeof s === 'object' ? s : null;
    const to = typeof t === 'object' ? t : null;
    const a = so ?? to;
    const b = to ?? so;
    writeVertexTriple(out, w, a?.x ?? 0, a?.y ?? 0, a?.z ?? 0);
    writeVertexTriple(out, w + 3, b?.x ?? 0, b?.y ?? 0, b?.z ?? 0);
    w += 6;
  }
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
    // Reuse the library's own visibility accessor (installed by useGraphFilter)
    // so the batched set matches what the per-link objects would have shown —
    // no duplicated hidden-ext / ghost predicate.
    return all.filter(visibilityPredicate<SimLink>(g.linkVisibility()));
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
    writeLinkSegments(links, positions);
    attr.needsUpdate = true;
  }

  function rebuild(): void {
    if (!enabled) return;
    links = visibleLinks();
    const needed = links.length * 2 * 3;
    if (!geometry) geometry = new THREE.BufferGeometry();
    if (positions.length < needed) {
      // Free the previous position attribute's GPU buffer before swapping in the
      // larger one. three.js does NOT delete a replaced BufferAttribute's GPU
      // buffer on setAttribute — it's freed only via the renderer's
      // attributes.remove(), which only geometry.dispose() (over the attributes
      // still in the geometry) routes to. Without this, every growth (un-hiding
      // an ext, added files, first hydration) orphaned the prior buffer on the
      // GPU until unmount. Dispose BEFORE the swap, while the old attribute is
      // still in the geometry; the next render re-uploads the new buffer (the
      // geometry re-registers its dispose listener automatically). Grow with
      // slack so this realloc+free is rare (mirrors instancedNodes).
      if (geometry.getAttribute('position')) geometry.dispose();
      positions = new Float32Array(
        capacityWithSlack(links.length, CAPACITY_SLACK) * 2 * 3,
      );
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    }
    geometry.setDrawRange(0, links.length * 2);
    if (!lineSegments) {
      lineSegments = new THREE.LineSegments(geometry, ensureMaterial());
      // Match the library's link renderOrder so links draw behind the
      // depth-test-disabled node sprites (NODE_RENDER_ORDER), as before.
      lineSegments.renderOrder = LINK_RENDER_ORDER;
      // One object spanning the whole graph — never cull it as a unit (its
      // bounding sphere leaves the frustum long before the links do).
      lineSegments.frustumCulled = false;
      lineSegments.raycast = () => {};
      lineSegments.userData['lattice:batchedLinks'] = true;
      scene.add(lineSegments);
    }
    lineSegments.visible = true;
    // Sync the rebuilt buffer directly so the new lines paint this frame.
    syncPositions();
    // Also force a sync on the next painted frame. On a fresh structural swap the
    // links captured above can still be pre-hydration (string source/target), so
    // the immediate syncPositions writes DEGENERATE (collapsed, invisible)
    // segments — see writeLinkSegments. The engine reheat would normally re-sync
    // them on its next motion tick, but a swap that reheats an already-settled
    // graph (e.g. the git-history ghost merge ~1s after open) can consume its
    // warmupTicks synchronously and produce no painted-frame motion, leaving the
    // degenerate buffer drawn until a drag/refresh forces a re-sync. markDirty
    // guarantees one post-hydration re-sync on the woken frame below. Mirrors
    // instancedNodes.rebuild().
    gate.markDirty();
    // The loop may be paused (settled graph) when the user toggles this on or a
    // filter changes the set — wake a few frames so the rebuilt lines paint.
    wakeInstancedRefresh(graph);
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
      wakeInstancedRefresh(graph);
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
