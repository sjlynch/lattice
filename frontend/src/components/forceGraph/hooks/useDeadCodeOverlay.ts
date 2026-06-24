import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { clearLabelsAndRefresh } from './refresh';
import { momentaryLetterMode, useHoldKeyMode } from './useHoldKeyMode';

// Dead-code overlay: active while the user holds `d` OR while the Dead view is
// pinned (the overlay-key chip latches the same state). Tracked in both state
// (for the HUD chip) and a ref (so the nodeThreeObject accessor wired at mount
// reads the live value). Same chord pattern as `h`/`z`/`w`: keyup / blur /
// visibilitychange all clear the hold so the recolor can't get stuck on if the
// user alt-tabs while holding the key (shared lifecycle in `useHoldKeyMode`);
// `pinned` is independent of those resets.
//
// Unlike LOC/health this is a pure recolor with no floating labels, so there's
// no repulsion RAF — just a refresh on toggle to re-evaluate nodeThreeObject
// without restarting the d3 simulation.
export function useDeadCodeOverlay(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  pinned: boolean,
) {
  const [held, setHeld] = useState(false);
  const deadMode = held || pinned;
  const deadModeRef = useRef(false);

  useEffect(() => {
    deadModeRef.current = deadMode;
  }, [deadMode]);

  useHoldKeyMode(momentaryLetterMode('d', setHeld));

  // Re-render node THREE objects when the overlay toggles. refresh()
  // re-evaluates nodeThreeObject without restarting the simulation.
  useEffect(() => {
    clearLabelsAndRefresh(graphRef.current);
  }, [deadMode, graphRef]);

  return { deadMode, deadModeRef };
}
