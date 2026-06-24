import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { healthLabelRegistry } from '../healthOverlay';
import { METRIC_REPULSION_BASE } from '../metricOverlayFactory';
import { startLabelRepulsion } from '../labelRepulsionFrames';
import type { GraphSettings } from '../graphSettings';
import { clearLabelsAndRefresh } from './refresh';
import { momentaryLetterMode, useHoldKeyMode } from './useHoldKeyMode';

// Code-health overlay: active while the user holds `h` OR while the Health view
// is pinned. The effective state is owned by App (so the Legend can swap to its
// breakdown panel) — this hook tracks the key hold locally and pushes the
// composed `held || pinned` up via `onHealthModeChange`. It's also mirrored to a
// ref here so the nodeThreeObject closure reads the live value.
//
// Same chord pattern as `z` (LOC) — keyup, blur, and visibility-change
// all reset the hold so we can't get stuck in an "always on" state if the user
// alt-tabs while holding the key (shared lifecycle in `useHoldKeyMode`);
// `pinned` is independent of those resets.
export function useHealthOverlay(
  healthMode: boolean,
  onHealthModeChange: (mode: boolean) => void,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settingsRef: MutableRefObject<GraphSettings>,
  pinned: boolean,
) {
  const healthModeRef = useRef(false);
  // `held` tracks just the key; the App-owned effective mode is held OR pinned.
  const [held, setHeld] = useState(false);

  useEffect(() => {
    healthModeRef.current = healthMode;
  }, [healthMode]);

  useHoldKeyMode(momentaryLetterMode('h', setHeld));

  // Compose the key-hold with the pin and push the result up to App's
  // `healthMode` (the single source the Legend + overlay effects read). Pinning
  // therefore latches the same state holding `h` drives.
  useEffect(() => {
    onHealthModeChange(held || pinned);
  }, [held, pinned, onHealthModeChange]);

  // Refresh sprites + drop the previous overlay's labels when the
  // health overlay toggles. Same shape as the LOC mode effect.
  // (We deliberately do NOT clear `hoverNode` here — the tooltip is
  // shown for every file hover regardless of the `h` key, so a
  // healthMode toggle shouldn't dismiss it.)
  useEffect(() => {
    clearLabelsAndRefresh(graphRef.current);
  }, [healthMode, graphRef]);

  // Same physics as the LOC loop — health labels are also short numbers, so they
  // share `METRIC_REPULSION_BASE` with LOC. Driven off the shared frame driver,
  // holding `labelPhysics` only while the labels are still moving (see
  // labelRepulsionFrames); `labelSpread` is read fresh each frame.
  useEffect(() => {
    if (!healthMode) return;
    return startLabelRepulsion(
      graphRef.current,
      healthLabelRegistry,
      () => METRIC_REPULSION_BASE * settingsRef.current.labelSpread,
    );
  }, [healthMode, settingsRef, graphRef]);

  return { healthModeRef };
}
