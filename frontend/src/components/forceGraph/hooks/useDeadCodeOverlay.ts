import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { clearLabelsAndRefresh, isTextInput } from './refresh';

// Dead-code overlay: active while the user holds `d`. Tracked in both state
// (for the HUD chip) and a ref (so the nodeThreeObject accessor wired at mount
// reads the live value). Same chord pattern as `h`/`z`/`w`: keyup / blur /
// visibilitychange all clear it so the recolor can't get stuck on if the user
// alt-tabs while holding the key.
//
// Unlike LOC/health this is a pure recolor with no floating labels, so there's
// no repulsion RAF — just a refresh on toggle to re-evaluate nodeThreeObject
// without restarting the d3 simulation.
export function useDeadCodeOverlay(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
) {
  const [deadMode, setDeadMode] = useState(false);
  const deadModeRef = useRef(false);

  useEffect(() => {
    deadModeRef.current = deadMode;
  }, [deadMode]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'd' && e.key !== 'D') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextInput(e.target)) return;
      if (e.repeat) return;
      setDeadMode(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'd' || e.key === 'D') setDeadMode(false);
    }
    function reset() {
      setDeadMode(false);
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

  // Re-render node THREE objects when the overlay toggles. refresh()
  // re-evaluates nodeThreeObject without restarting the simulation.
  useEffect(() => {
    clearLabelsAndRefresh(graphRef.current);
  }, [deadMode, graphRef]);

  return { deadMode, deadModeRef };
}
