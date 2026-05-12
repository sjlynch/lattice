import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { locLabelRegistry } from '../locOverlay';
import { repelLabels } from '../labelRepulsion';
import type { GraphSettings } from '../graphSettings';
import { clearLabelsAndRefresh, isTextInput } from './refresh';

// Lines-of-code overlay: active while the user holds `z`. Tracked in
// both state (for the chip overlay) and a ref (so the nodeThreeObject
// accessor — wired into the graph once at mount — reads the live value).
//
// Toggle on/off when `z` is held. Keyup also fires on window blur
// (Alt-Tab, dev-tools focus) — we can't trust `keyup` alone, so reset
// on blur and on visibility loss as well.
export function useLocOverlay(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settingsRef: MutableRefObject<GraphSettings>,
) {
  const [locMode, setLocMode] = useState(false);
  const locModeRef = useRef(false);

  useEffect(() => {
    locModeRef.current = locMode;
  }, [locMode]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'z' && e.key !== 'Z') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextInput(e.target)) return;
      if (e.repeat) return;
      setLocMode(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'z' || e.key === 'Z') setLocMode(false);
    }
    function reset() {
      setLocMode(false);
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
  }, []);

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
    let rafId = 0;
    const tick = () => {
      repelLabels(locLabelRegistry, 55 * settingsRef.current.labelSpread);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [locMode, settingsRef]);

  return { locMode, locModeRef };
}
