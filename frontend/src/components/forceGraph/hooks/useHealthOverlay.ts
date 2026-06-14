import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { healthLabelRegistry } from '../healthOverlay';
import { startLabelRepulsion } from '../labelRepulsionFrames';
import type { GraphSettings } from '../graphSettings';
import { clearLabelsAndRefresh, isTextInput } from './refresh';

// Code-health overlay: active while the user holds `h`. State is owned
// by App (so the Legend can react), but mirrored to a ref here so the
// nodeThreeObject closure reads the live value.
//
// Same chord pattern as `z` (LOC) — keyup, blur, and visibility-change
// all reset so we can't get stuck in an "always on" state if the user
// alt-tabs while holding the key.
export function useHealthOverlay(
  healthMode: boolean,
  onHealthModeChange: (mode: boolean) => void,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settingsRef: MutableRefObject<GraphSettings>,
) {
  const healthModeRef = useRef(false);

  useEffect(() => {
    healthModeRef.current = healthMode;
  }, [healthMode]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'h' && e.key !== 'H') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextInput(e.target)) return;
      if (e.repeat) return;
      onHealthModeChange(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'h' || e.key === 'H') onHealthModeChange(false);
    }
    function reset() {
      onHealthModeChange(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [onHealthModeChange]);

  // Refresh sprites + drop the previous overlay's labels when the
  // health overlay toggles. Same shape as the LOC mode effect.
  // (We deliberately do NOT clear `hoverNode` here — the tooltip is
  // shown for every file hover regardless of the `h` key, so a
  // healthMode toggle shouldn't dismiss it.)
  useEffect(() => {
    clearLabelsAndRefresh(graphRef.current);
  }, [healthMode, graphRef]);

  // Same physics as the LOC loop — health labels are also short numbers, so the
  // per-overlay base is 55 units. Driven off the shared frame driver, holding
  // `labelPhysics` only while the labels are still moving (see
  // labelRepulsionFrames); `labelSpread` is read fresh each frame.
  useEffect(() => {
    if (!healthMode) return;
    return startLabelRepulsion(
      graphRef.current,
      healthLabelRegistry,
      () => 55 * settingsRef.current.labelSpread,
    );
  }, [healthMode, settingsRef, graphRef]);

  return { healthModeRef };
}
