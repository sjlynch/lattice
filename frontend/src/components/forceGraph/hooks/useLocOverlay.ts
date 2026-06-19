import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { locLabelRegistry } from '../locOverlay';
import { startLabelRepulsion } from '../labelRepulsionFrames';
import type { GraphSettings } from '../graphSettings';
import { clearLabelsAndRefresh } from './refresh';
import { momentaryLetterMode, useHoldKeyMode } from './useHoldKeyMode';

// Lines-of-code overlay: active while the user holds `z`. Tracked in
// both state (for the chip overlay) and a ref (so the nodeThreeObject
// accessor — wired into the graph once at mount — reads the live value).
//
// Toggle on/off when `z` is held. Keyup also fires on window blur
// (Alt-Tab, dev-tools focus) — we can't trust `keyup` alone, so reset
// on blur and on visibility loss as well (shared lifecycle in
// `useHoldKeyMode`).
export function useLocOverlay(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settingsRef: MutableRefObject<GraphSettings>,
) {
  const [locMode, setLocMode] = useState(false);
  const locModeRef = useRef(false);

  useEffect(() => {
    locModeRef.current = locMode;
  }, [locMode]);

  useHoldKeyMode(momentaryLetterMode('z', setLocMode));

  // Re-render node THREE objects when the LOC overlay toggles.
  // refresh() re-evaluates nodeThreeObject without restarting the d3
  // simulation, so node positions stay put.
  useEffect(() => {
    clearLabelsAndRefresh(graphRef.current);
  }, [locMode, graphRef]);

  // Spread LOC labels apart so their text doesn't overlap in dense
  // clusters, with a velocity-based settle so the system stops moving
  // once an equilibrium is reached. Shared physics implementation
  // lives in labelRepulsion.ts; only the minimum desired separation
  // differs per overlay (LOC numbers are short, so the per-overlay
  // base is 55 units). The user-tweakable `labelSpread` multiplier is
  // read fresh each tick so dragging the slider feels live.
  useEffect(() => {
    if (!locMode) return;
    // See `labelRepulsionFrames` for the shared frame-driven, rest-gated loop
    // used by all three repulsion overlays.
    return startLabelRepulsion(
      graphRef.current,
      locLabelRegistry,
      () => 55 * settingsRef.current.labelSpread,
    );
  }, [locMode, settingsRef, graphRef]);

  return { locMode, locModeRef };
}
