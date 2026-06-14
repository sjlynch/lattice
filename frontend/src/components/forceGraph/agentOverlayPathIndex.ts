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
  }

  // Vertical extent of the indexed nodes, or null when nothing is indexed.
  bounds(): GraphBounds | null {
    let minY = Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (const node of this.byPath.values()) {
      const y = node.y ?? 0;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
    }
    return count > 0 ? { minY, maxY } : null;
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
