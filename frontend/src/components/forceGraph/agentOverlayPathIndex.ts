// Path normalization + the path→sim-node index and the geometric queries
// (vertical bounds, centroid/spread) the overlay derives from live node
// positions. Kept separate from agentOverlay.ts so the index lifecycle and
// graph-bounds math can be reasoned about on their own.

import type { ForceGraph3DInstance } from '3d-force-graph';
import {
  HOVER_MARGIN_FRACTION,
  HOVER_MARGIN_MAX,
  HOVER_MARGIN_MIN,
  PARKED_BASE_RADIUS,
} from './agentOverlayConstants';
import type { SimNode } from './agentOverlayTypes';

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

export function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}

export type GraphBounds = { minY: number; maxY: number };

// Centroid (X/Z) of all indexed nodes plus the max radial distance from it,
// floored at PARKED_BASE_RADIUS — used to park freshly-spawned agents.
export type CentroidSpread = { cx: number; cz: number; maxR: number };

// The hover line sits a clamped fraction of the graph's vertical extent above
// its top — neither glued to the graph nor lost in space on a very tall/short
// tree. Pure, so it can be unit-tested.
export function hoverMargin(bounds: GraphBounds): number {
  return Math.min(
    HOVER_MARGIN_MAX,
    Math.max(
      HOVER_MARGIN_MIN,
      (bounds.maxY - bounds.minY) * HOVER_MARGIN_FRACTION,
    ),
  );
}

export class AgentPathIndex {
  private byPath = new Map<string, SimNode>();
  private indexedNodes: object[] | null = null;
  // Cached vertical bounds. Recomputing every frame is an O(N) scan over every
  // file node; node positions only move while the d3 layout is live, so the
  // overlay invalidates this (via `invalidateBounds`) only on engine-hot frames
  // and a structural swap, and reuses the cache once the layout has settled.
  private cachedBounds: GraphBounds | null = null;
  private boundsValid = false;

  // Release the graph generation when no agents need it. The overlay may never
  // tick again while inactive, so cleanup belongs to removal/teardown.
  clear(): void {
    this.byPath.clear();
    this.indexedNodes = null;
    this.cachedBounds = null;
    this.boundsValid = false;
  }

  get(normPath: string): SimNode | undefined {
    return this.byPath.get(normPath);
  }

  // Rebuild the path→node index only when the library swaps the nodes array
  // (a structural graphData() change). Positions on the same node objects
  // update in place, so the cached refs stay valid between swaps.
  ensure(graph: ForceGraph3DInstance): void {
    const getData = graph.graphData as unknown as () => { nodes?: object[] };
    const nodes = getData.call(graph)?.nodes ?? [];
    if (nodes === this.indexedNodes) return;
    this.indexedNodes = nodes;
    this.byPath.clear();
    for (const obj of nodes as SimNode[]) {
      if (typeof obj.path === 'string') {
        this.byPath.set(normalizePath(obj.path), obj);
      }
    }
    this.boundsValid = false; // fresh node set → recompute bounds on next read
  }

  // Mark the cached bounds stale (call while node positions may have moved).
  invalidateBounds(): void {
    this.boundsValid = false;
  }

  // Vertical extent of the indexed nodes, or null when nothing is indexed.
  // Memoised; `invalidateBounds` / a structural swap force a recompute.
  bounds(): GraphBounds | null {
    if (this.boundsValid) return this.cachedBounds;
    let minY = Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (const node of this.byPath.values()) {
      const y = node.y ?? 0;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
    }
    this.cachedBounds = count > 0 ? { minY, maxY } : null;
    this.boundsValid = true;
    return this.cachedBounds;
  }

  centroidSpread(): CentroidSpread | null {
    let cx = 0;
    let cz = 0;
    let n = 0;
    for (const node of this.byPath.values()) {
      cx += node.x ?? 0;
      cz += node.z ?? 0;
      n++;
    }
    if (n === 0) return null;
    cx /= n;
    cz /= n;
    let maxR = PARKED_BASE_RADIUS;
    for (const node of this.byPath.values()) {
      const dx = (node.x ?? 0) - cx;
      const dz = (node.z ?? 0) - cz;
      maxR = Math.max(maxR, Math.hypot(dx, dz));
    }
    return { cx, cz, maxR };
  }
}
