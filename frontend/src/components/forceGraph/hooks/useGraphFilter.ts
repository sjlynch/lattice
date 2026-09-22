import { useEffect, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode } from '../../../api';
import { getIdleController } from '../idleController';
import { isGhost } from '../timelineDiff';
import type { ChangeKind } from '../changeRing';

// Filter via accessors — does not restart the d3 force simulation.
// Ghost nodes are visible only when the active scrubber range marks
// their path with a change kind ("deleted" most often, but also
// "added" if a file was added inside the window and then later
// removed before the user scrubbed).
//
// While a metric view (health `h` / loc `z` / dead `d`) is active the graph is
// pared down to just the metric signal: ghost (deleted-file) nodes are hidden
// outright and files whose extension is on the metrics-ignore list (`.json`,
// `.md`, … — config/prose with no real code-health signal) drop out too, so
// they don't clutter the colored view. Both are read through refs and the view
// toggle already runs a `graph.refresh()` (LOC/health/dead hooks), which
// re-evaluates these accessors — so releasing the view brings them back.
//
// The accessor closures read only `hiddenExts` plus the live refs
// (`changeMapRef`, `metricsIgnoredExtsRef`, `metricOverlayActiveRef`). They
// never read the ScanResult, git history, or the scrubber range directly —
// `range` matters solely via the change map. So those are intentionally NOT
// deps: re-installing the accessors on every HealthUpdate (`data`) or every
// scrubber pixel (`range`/`history`) would make the library re-evaluate
// visibility for all N nodes/links with identical logic — pure churn. On a
// scrubber change-set flip, `useGitTimeline`'s `applyChangeRingDelta` toggles
// the affected ghost nodes' visibility directly (O(changed), no refresh); this
// still-installed accessor remains the source of truth for genuine refreshes
// and data swaps (it reads the live map), so ghosts stay correct there too.
export function useGraphFilter(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  hiddenExts: Set<string>,
  changeMapRef: MutableRefObject<Map<string, ChangeKind>>,
  metricsIgnoredExtsRef: MutableRefObject<Set<string>>,
  metricOverlayActiveRef: MutableRefObject<boolean>,
) {
  useEffect(() => {
    if (!graphRef.current) return;
    function isNodeVisible(n: GraphNode): boolean {
      const metricView = metricOverlayActiveRef.current;
      if (isGhost(n)) {
        // Hidden entirely while a metric view is active (they're noise there);
        // otherwise visible only when the current change map covers their path.
        // Read the ref live each call: `useGitTimeline` swaps in a fresh
        // Map on every change-set flip, and this effect no longer re-runs
        // per scrubber tick, so capturing the map once would go stale.
        return !metricView && changeMapRef.current.has(n.path);
      }
      if (n.kind === 'dir') return true;
      const key = n.ext ? n.ext.toLowerCase() : '*';
      if (hiddenExts.has(key)) return false;
      // Metrics-ignored extensions (.json etc.) carry no health/loc/dead signal,
      // so drop them while a metric view is active.
      if (metricView && metricsIgnoredExtsRef.current.has(key)) return false;
      return true;
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
    // The accessor swap only takes effect at the library's next digest, which
    // mutates the scene without rendering it. With the batched renderers on,
    // their rebuild effects happen to wake the loop; with them off, a legend
    // toggle on a settled (paused) scene didn't repaint until the next
    // interaction. Wake a short frame tail here so the filter always paints.
    getIdleController(graphRef.current)?.wakeForRefresh();
  }, [
    graphRef,
    hiddenExts,
    changeMapRef,
    metricsIgnoredExtsRef,
    metricOverlayActiveRef,
  ]);
}
