import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GitHistoryResult, GraphNode, ScanResult } from '../../../api';
import { healthLabelRegistry } from '../healthOverlay';
import { labelsRegistry } from '../labelsOverlay';
import { locLabelRegistry } from '../locOverlay';
import { buildGhostGraphData } from '../timelineDiff';

type Args = {
  graphRef: MutableRefObject<ForceGraph3DInstance | null>;
  data: ScanResult | null;
  history: GitHistoryResult | null;
  onResetSelection: () => void;
};

// Pushes the scan + git history into the ForceGraph instance only when
// either input changes. Ghost nodes (deleted files surfaced from git
// history) are merged into graphData here so the physics simulation
// places them once; scrubbing the timeline only flips visibility/rings
// afterward and never causes a graphData restart. Label registries are
// cleared on every swap because their Sprite references get replaced.
export function useGraphDataSync({
  graphRef,
  data,
  history,
  onResetSelection,
}: Args) {
  const ghostsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!graphRef.current) return;
    locLabelRegistry.clear();
    labelsRegistry.clear();
    healthLabelRegistry.clear();
    if (!data) {
      graphRef.current.graphData({ nodes: [], links: [] });
      ghostsRef.current = new Set();
      return;
    }
    const ghostIds = new Set<string>();
    let ghostNodes: GraphNode[] = [];
    let ghostLinks: { source: string; target: string }[] = [];
    if (history && history.isRepo) {
      const built = buildGhostGraphData(data, history.commits, history.uncommitted);
      ghostNodes = built.ghostNodes;
      ghostLinks = built.ghostLinks;
      for (const g of built.ghostNodes) ghostIds.add(g.id);
    }
    ghostsRef.current = ghostIds;
    graphRef.current.graphData({
      nodes: [...data.nodes, ...ghostNodes],
      links: [...data.links, ...ghostLinks],
    });
    // A new scan invalidates the previous selection (node IDs may differ).
    onResetSelection();
  }, [data, history]);

  return { ghostsRef };
}
