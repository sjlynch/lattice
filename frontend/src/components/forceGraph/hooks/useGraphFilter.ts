import { useEffect, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode } from '../../../api';
import { isGhost } from '../timelineDiff';
import type { ChangeKind } from '../changeRing';

// Filter via accessors — does not restart the d3 force simulation.
// Ghost nodes are visible only when the active scrubber range marks
// their path with a change kind ("deleted" most often, but also
// "added" if a file was added inside the window and then later
// removed before the user scrubbed).
//
// The accessor closures read only `hiddenExts` and `changeMapRef.current`
// (a ref, read live each call). They never read the ScanResult, git
// history, or the scrubber range directly — `range` matters solely via
// the change map. So those are intentionally NOT deps: re-installing the
// accessors on every HealthUpdate (`data`) or every scrubber pixel
// (`range`/`history`) would make the library re-evaluate visibility for
// all N nodes/links with identical logic — pure churn. On a scrubber
// change-set flip, `useGitTimeline`'s `applyChangeRingDelta` toggles the
// affected ghost nodes' visibility directly (O(changed), no refresh); this
// still-installed accessor remains the source of truth for genuine refreshes
// and data swaps (it reads the live map), so ghosts stay correct there too.
export function useGraphFilter(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  hiddenExts: Set<string>,
  changeMapRef: MutableRefObject<Map<string, ChangeKind>>,
) {
  useEffect(() => {
    if (!graphRef.current) return;
    function isNodeVisible(n: GraphNode): boolean {
      if (isGhost(n)) {
        // Only show ghost nodes whose path is in the current change map.
        // Read the ref live each call: `useGitTimeline` swaps in a fresh
        // Map on every change-set flip, and this effect no longer re-runs
        // per scrubber tick, so capturing the map once would go stale.
        return changeMapRef.current.has(n.path);
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
  }, [graphRef, hiddenExts, changeMapRef]);
}
