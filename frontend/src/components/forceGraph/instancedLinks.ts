// Batched link rendering — the library's one-`THREE.Line`-per-link (E draw calls
// every rendered frame, ~half the scene objects, even for a pure orbit of a
// settled graph) collapses into a single `THREE.LineSegments`.
//
// `linkThreeObject` is swapped for an empty `Object3D` (no geometry → no draw
// call, and `tickFrame` skips its geometry update), and every visible link is
// drawn here with two vertices. Positions re-upload only on frames nodes moved —
// keyed off the shared `nodeMotionDriver` (engine tick OR node drag) plus one
// settling frame — never during a pure orbit. Not `isEngineHot()` (misses drags)
// nor `onEngineTick` alone (a drag after settle never re-ticks below
// `d3AlphaMin`). Links carry no overlays and aren't pick targets (raycast
// disabled), so nothing depends on the removed per-link objects. Flat 1px lines;
// the `batchedLinks` setting keeps the cylinder look available.
//
// This controller owns link capture, hydration and motion scheduling;
// instancedLinkResources.ts owns the graph-local geometry, buffers and material.

import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { createMotionSyncGate } from './motionSyncGate';
import {
  visibilityPredicate,
  wakeInstancedRefresh,
} from './instancedBatching';
import { createInstancedLinkResources, type SimLink } from './instancedLinkResources';

export { writeLinkSegments } from './instancedLinkResources';

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

export type InstancedLinks = {
  setEnabled(on: boolean): void;
  /** Re-read the visible link set + resize the buffer (structural / filter change). */
  rebuild(): void;
  /** Per-frame hook (wire to the scene frame driver). Syncs positions while live. */
  onFrame(): void;
  dispose(): void;
};

// The controller is stamped onto the graph instance (mirrors
// `attachIdleController`) so a caller that already holds the graph can ask it to
// re-capture its visible-link set without threading another ref through the
// React tree. `changeRingSync` needs exactly that: it toggles ghost-node
// visibility in place — deliberately skipping the library digest that would
// otherwise re-evaluate `linkVisibility` — so the batched buffer is the only
// thing left still drawing the vanished ghost's link.
const CTRL_KEY = '__latticeInstancedLinks' as const;

type WithInstancedLinks = {
  [CTRL_KEY]?: InstancedLinks;
};

export function getInstancedLinks(
  graph: ForceGraph3DInstance | null,
): InstancedLinks | null {
  if (!graph) return null;
  return (graph as unknown as WithInstancedLinks)[CTRL_KEY] ?? null;
}

// A unique empty object per link: no geometry (no draw call), and `tickFrame`'s
// position update no-ops for it (it's neither a Line nor a Mesh).
const emptyLinkObject = () => new THREE.Object3D();

function isHydratedLink(link: SimLink): boolean {
  const l = link as unknown as { source: unknown; target: unknown };
  return typeof l.source === 'object' && l.source !== null
    && typeof l.target === 'object' && l.target !== null;
}

export function createInstancedLinks(graph: ForceGraph3DInstance): InstancedLinks {
  const g = graph as unknown as LinkGraph;
  const resources = createInstancedLinkResources(g.scene(), {
    sampleColor(link) {
      const rawColor = g.linkColor();
      return typeof rawColor === 'function'
        ? (rawColor as (l: SimLink | undefined) => unknown)(link)
        : rawColor;
    },
    readOpacity: () => g.linkOpacity?.() ?? 1,
  });

  let enabled = false;
  // The visible links captured at the last rebuild, in buffer order.
  let links: SimLink[] = [];
  // Set when the last rebuild captured links whose endpoints were still id
  // strings (the library hydrates them to node objects on its debounced digest,
  // AFTER graphData() and our rebuild effect). The visibility accessor can only
  // judge hydrated endpoints, so a pre-hydration capture keeps every link —
  // including those to hidden-ext files and out-of-window ghosts (the git-history
  // ghost merge ~1s after open is the usual trigger), which then drew as lines
  // into empty space. onFrame re-captures once hydration lands.
  let needsRecapture = false;
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

  function rebuild(): void {
    if (!enabled) return;
    links = visibleLinks();
    needsRecapture = links.some((l) => !isHydratedLink(l));
    resources.rebuild(links);
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
    if (!enabled || !resources.hasBatch()) return;
    if (needsRecapture && links.every(isHydratedLink)) {
      rebuild();
      return;
    }
    if (gate.shouldSync()) resources.syncPositions(links);
  }

  function releaseResources(): void {
    resources.dispose();
    links = [];
    needsRecapture = false;
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
      // Disabled rebuilds are skipped, so release the captured graph references
      // along with the inactive renderer's owned buffers.
      releaseResources();
      wakeInstancedRefresh(graph);
    }
  }

  function dispose(): void {
    gate.detach();
    releaseResources();
    // Only clear the stamp if it's still ours — a StrictMode remount creates the
    // replacement controller before this teardown runs.
    const holder = graph as unknown as WithInstancedLinks;
    if (holder[CTRL_KEY] === api) delete holder[CTRL_KEY];
  }

  const api: InstancedLinks = { setEnabled, rebuild, onFrame, dispose };
  (graph as unknown as WithInstancedLinks)[CTRL_KEY] = api;
  return api;
}
