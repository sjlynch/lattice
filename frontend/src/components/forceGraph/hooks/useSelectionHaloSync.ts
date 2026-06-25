import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { applySelectionHaloDelta } from '../selectionHaloSync';

// Targeted halo updates — toggle the halo Sprite on only the affected node ids
// instead of calling `graph.refresh()`, which re-runs `nodeThreeObject` for
// every node in the scene. On a 1000-file project this turns a 50–200 ms commit
// per click into <1 ms. The halo only reads node sizes (via baseSizeFor), so the
// deps are narrowed to selection + the two size settings — dragging an unrelated
// slider (charge, link distance, label spread, …) doesn't re-run the O(N) delta
// or wake the loop for an unchanged selection.
export function useSelectionHaloSync(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  selected: Set<string>,
  settings: GraphSettings,
): void {
  const prevSelectedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) {
      prevSelectedRef.current = selected;
      return;
    }
    applySelectionHaloDelta(graph, prevSelectedRef.current, selected, settings);
    prevSelectedRef.current = selected;
    // Drive a few render frames so the new halo paints — the render loop is
    // otherwise paused while the engine is settled.
    getIdleController(graph)?.wakeForRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, settings.fileNodeSize, settings.dirNodeSize]);
}
