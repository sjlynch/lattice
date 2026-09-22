import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphSettings } from '../graphSettings';
import { createInstancedNodes, type InstancedNodes } from '../instancedNodes';
import { onFrame } from '../sceneFrameDriver';
import { clearLabelsAndRefresh } from './refresh';

// Owns the batched-nodes controller (`instancedNodes.ts`) and keeps it in step
// with the toggle, the visible node set, node sizes, and the recolor-overlay
// state. Mounted after the graph init + useGraphDataSync + useGraphFilter so the
// controller can read the library's installed `nodeVisibility` accessor and the
// freshly-swapped node array when it rebuilds.
export function useInstancedNodes(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  enabled: boolean,
  hiddenExts: Set<string>,
  settings: GraphSettings,
  // Read live so the controller's per-frame `isBaseView()` reflects the current
  // recolor-overlay state without re-creating the controller.
  modeRefs: {
    settingsRef: MutableRefObject<GraphSettings>;
    healthModeRef: MutableRefObject<boolean>;
    locModeRef: MutableRefObject<boolean>;
    deadModeRef: MutableRefObject<boolean>;
  },
  // Bumped by useGraphDataSync on every full graphData() swap (which replaces
  // the node object array the controller captures per styleKey). Some swaps —
  // notably the git-history ghost merge — leave `structuralData` unchanged (it
  // keys on `data.links`, but ghosts derive from `history`), so without this dep
  // the meshes would keep tracking orphaned pre-swap node objects. Re-rebuild on
  // every swap to re-capture.
  dataGeneration: number,
  // True while a metric view (health/loc/dead) is showing. That view hides
  // metrics-ignored files (.json, .md, …) through `nodeVisibility`, so a rebuild
  // made DURING it (size slider, legend toggle, new file) drops them from the
  // meshes — and on return to the base view their per-node sprites are hidden
  // again (batched), so they drew nothing at all until some unrelated rebuild.
  // Re-capture on the toggle, exactly as useBatchedLinks does.
  metricOverlayActive: boolean,
) {
  const ctrlRef = useRef<InstancedNodes | null>(null);
  const mountedRef = useRef(false);

  // Create the controller + per-frame subscription once (init runs in a layout
  // effect, so graphRef.current is set by the time this passive effect fires).
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const ctrl = createInstancedNodes(graph, {
      getSettings: () => modeRefs.settingsRef.current,
      isBaseView: () =>
        !modeRefs.healthModeRef.current &&
        !modeRefs.locModeRef.current &&
        !modeRefs.deadModeRef.current,
    });
    ctrlRef.current = ctrl;
    const off = onFrame(graph, () => ctrl.onFrame());
    return () => {
      off();
      ctrl.dispose();
      ctrlRef.current = null;
    };
    // modeRefs holds stable ref objects (their .current is read live); the
    // controller is intentionally created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphRef]);

  // Toggle. `nodeObjectFactory` reads `batchedNodesRef` to hide/show the per-node
  // base sprite, so a runtime toggle needs a graph.refresh() to flip those — but
  // NOT on the initial mount, where init already built the sprites at the right
  // visibility (the ref is seeded from the persisted setting before init runs).
  useEffect(() => {
    ctrlRef.current?.setEnabled(enabled);
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    clearLabelsAndRefresh(graphRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Rebuild the instance buffers when the visible set or node sizes change.
  // Runs after useGraphFilter's hiddenExts effect (registered earlier), so the
  // nodeVisibility accessor is up to date when the controller re-reads it.
  useEffect(() => {
    if (!enabled) return;
    ctrlRef.current?.rebuild();
  }, [
    enabled,
    hiddenExts,
    settings.fileNodeSize,
    settings.dirNodeSize,
    dataGeneration,
    metricOverlayActive,
  ]);
}
