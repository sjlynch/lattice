import { useEffect, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GitHistoryResult, GraphNode, ScanResult } from '../../../api';
import { isGhost } from '../timelineDiff';
import type { ChangeKind } from '../changeRing';

// Filter via accessors — does not restart the d3 force simulation.
// Ghost nodes are visible only when the active scrubber range marks
// their path with a change kind ("deleted" most often, but also
// "added" if a file was added inside the window and then later
// removed before the user scrubbed).
export function useGraphFilter(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  hiddenExts: Set<string>,
  data: ScanResult | null,
  history: GitHistoryResult | null,
  range: { left: number; right: number },
  changeMapRef: MutableRefObject<Map<string, ChangeKind>>,
) {
  useEffect(() => {
    if (!graphRef.current) return;
    const changeMap = changeMapRef.current;
    function isNodeVisible(n: GraphNode): boolean {
      if (isGhost(n)) {
        // Only show ghost nodes whose path is in the current change map.
        return changeMap.has(n.path);
      }
      if (n.kind === 'dir') return true;
      const key = n.ext ? n.ext.toLowerCase() : '*';
      return !hiddenExts.has(key);
    }
    graphRef.current
      .nodeVisibility((n: object) => isNodeVisible(n as GraphNode))
      .linkVisibility((l: object) => {
        const link = l as {
          source: GraphNode | string;
          target: GraphNode | string;
        };
        // After graphData() is applied, source/target are hydrated to
        // node references. Before that, they're still IDs — show them
        // until hydration catches up.
        const s = typeof link.source === 'object' ? link.source : null;
        const t = typeof link.target === 'object' ? link.target : null;
        return (!s || isNodeVisible(s)) && (!t || isNodeVisible(t));
      });
  }, [graphRef, hiddenExts, data, history, range, changeMapRef]);
}
