import type { MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';

export type GraphRef = MutableRefObject<ForceGraph3DInstance | null>;

export function hasMountedNodes(g: ForceGraph3DInstance): boolean {
  return g.graphData().nodes.length > 0;
}
