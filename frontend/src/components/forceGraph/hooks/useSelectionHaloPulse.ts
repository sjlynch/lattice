import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { getIdleController } from '../idleController';
import { onFrame } from '../sceneFrameDriver';
import { resetHaloPulse, updateHaloPulse } from '../halo';

// Pulses two shared SpriteMaterials in lock-step: the selection ring's tint
// brightens toward white while the additive glow's opacity rises, then both
// return to rest. `halo.ts::updateHaloPulse` updates them in O(1) per frame
// regardless of selected-node count; allocation belongs to `haloResources.ts`.
//
// This hook owns the `onFrame` subscription and the idle controller's slow-only
// `halo` reason, held only while selected (~30fps when no faster reason is held).
// Clearing selection releases the reason, resets both existing materials
// (base ring tint, glow opacity 0), and requests one paint via `wakeForRefresh`.
// Teardown unsubscribes, releases any held reason, and resets; pulse/reset never
// allocate resources. See ../CLAUDE.md for full resource ownership details.
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
