import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { getIdleController } from '../idleController';
import { onFrame } from '../sceneFrameDriver';
import { resetHaloPulse, updateHaloPulse } from '../halo';

// Pulses the selection halo between its base color and a brighter/whiter tint
// so selected nodes (search hits or box-selected) stay visible in dense graphs.
//
// Performance: the halo is ONE shared SpriteMaterial (see halo.ts), so the
// pulse recolors a single material per frame — O(1) regardless of how many
// nodes are selected; every mounted halo sprite picks up the new tint for free.
//
// Render-on-demand: while a selection exists the pulse holds the idle
// controller's `halo` reason (a slow-only reason, like `agents`/`labelPhysics`)
// so the loop keeps painting but duty-cycles to ~30fps — plenty for a ~1s pulse
// at half the render cost. An empty selection releases the reason and the loop
// suspends again. The per-frame recolor rides the scene's real render frames via
// `onFrame`; clearing the selection restores the base tint and paints it once
// with `wakeForRefresh` (the loop is otherwise about to suspend).
export function useSelectionHaloPulse(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  hasSelection: boolean,
): void {
  // Whether we currently hold the `halo` reason. Kept as a ref so the once-
  // registered frame callback can gate its work without re-subscribing, and so
  // teardown can release a lingering hold.
  const heldRef = useRef(false);

  // Register the per-frame recolor once. It only does work while `halo` is held
  // (i.e. a selection exists), so selection-free renders pay nothing.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const offFrame = onFrame(graph, (now) => {
      if (heldRef.current) updateHaloPulse(now);
    });
    return () => {
      offFrame();
      if (heldRef.current) {
        heldRef.current = false;
        getIdleController(graph)?.releaseHalo();
      }
      resetHaloPulse();
    };
  }, [graphRef]);

  // Hold the `halo` reason exactly while a selection exists.
  useEffect(() => {
    const idle = getIdleController(graphRef.current);
    if (!idle) return;
    if (hasSelection && !heldRef.current) {
      heldRef.current = true;
      idle.acquireHalo();
    } else if (!hasSelection && heldRef.current) {
      heldRef.current = false;
      idle.releaseHalo();
      resetHaloPulse();
      // Paint the reset-to-base tint once; the loop is otherwise suspending.
      idle.wakeForRefresh();
    }
  }, [graphRef, hasSelection]);
}
