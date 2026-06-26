import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../../api';
import { createInstancedLinks, type InstancedLinks } from '../instancedLinks';
import { onFrame } from '../sceneFrameDriver';

// Owns the batched-links controller (`instancedLinks.ts`) and keeps it in step
// with the toggle + the visible link set. Mounted after the graph init +
// useGraphFilter so the controller can read the library's installed
// `linkVisibility` accessor when it rebuilds.
export function useBatchedLinks(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  enabled: boolean,
  // A structure-only scan reference (changes only when files are added/removed/
  // renamed) — the visible link set can only change on a structural swap or a
  // hidden-extension change, never on a metric-only HealthUpdate.
  structuralData: ScanResult | null,
  hiddenExts: Set<string>,
  // Bumped by useGraphDataSync on every full graphData() swap (which replaces
  // the link object array). Some swaps — notably the git-history ghost merge —
  // don't change `structuralData` (it keys on `data.links`, but ghosts derive
  // from `history`), so without this dep the controller would keep rendering the
  // orphaned pre-swap link objects. Re-rebuild on every swap to re-capture.
  dataGeneration: number,
  // True while a metric view (health/loc/dead) is active. Those views hide
  // ghost nodes and metrics-ignored files via `linkVisibility`, so the batched
  // link buffer must re-capture on the toggle — otherwise links to the now-
  // hidden nodes would stay drawn as stray lines into empty space (the per-link
  // fallback re-reads visibility on the toggle's refresh; the batched buffer
  // only re-reads on rebuild).
  metricOverlayActive: boolean,
) {
  const ctrlRef = useRef<InstancedLinks | null>(null);

  // Create the controller + per-frame subscription once, after the graph exists
  // (init runs in a layout effect, so graphRef.current is set by the time this
  // passive effect fires).
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const ctrl = createInstancedLinks(graph);
    ctrlRef.current = ctrl;
    const off = onFrame(graph, () => ctrl.onFrame());
    return () => {
      off();
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, [graphRef]);

  // Toggle. setEnabled rebuilds on its own enable transition.
  useEffect(() => {
    ctrlRef.current?.setEnabled(enabled);
  }, [enabled]);

  // Rebuild when the visible link set can change. Runs after useGraphFilter's
  // own hiddenExts effect (registered earlier), so the library's linkVisibility
  // accessor is already up to date when we re-read it.
  useEffect(() => {
    if (!enabled) return;
    ctrlRef.current?.rebuild();
  }, [enabled, structuralData, hiddenExts, dataGeneration, metricOverlayActive]);
}
