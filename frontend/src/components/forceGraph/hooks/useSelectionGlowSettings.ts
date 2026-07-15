import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphSettings } from '../graphSettings';
import { configureSelectionGlow } from '../halo';
import { getIdleController } from '../idleController';
import { rebuildSelectionHalos } from '../selectionHaloSync';

// Pushes the Rendering-tab selection-glow knobs (`selectionGlowStrength` /
// `selectionGlowScale`) into the halo module and applies changes to the current
// selection:
//   - strength is read live each frame by `updateHaloPulse`, so a change just
//     needs a wake to repaint (the pulse loop is already running while selected);
//   - scale is read when a halo is built, so a change rebuilds the existing
//     selection's halos in place (O(selected), not a full graph.refresh()).
// The config is pushed on EVERY run (including mount) so a persisted non-default
// reaches the halo module before the first selection — mirroring the physics
// force-pokes. `selected`/`settings` are read through the effect closure (which
// carries the current render's values) so the effect only re-fires on a glow-knob
// change, not on every selection change (the halo delta sync already builds new
// halos with the live `_glowScale`).
export function useSelectionGlowSettings(
  settings: GraphSettings,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  selected: Set<string>,
): void {
  const appliedRef = useRef<{ strength: number; scale: number } | null>(null);
  useEffect(() => {
    const prev = appliedRef.current;
    const strength = settings.selectionGlowStrength;
    const scale = settings.selectionGlowScale;
    appliedRef.current = { strength, scale };
    // Idempotent push so persisted non-defaults land even before a selection.
    configureSelectionGlow({ strength, scale });

    const graph = graphRef.current;
    if (!graph || !prev) return; // mount: nothing built yet to update
    if (prev.scale !== scale) rebuildSelectionHalos(graph, selected, settings);
    if (prev.strength !== strength || prev.scale !== scale) {
      // Paint the change — the loop may be idle (no selection) or slow-cycling.
      getIdleController(graph)?.wakeForRefresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.selectionGlowStrength, settings.selectionGlowScale]);
}
