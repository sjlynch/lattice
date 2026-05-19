import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../../api';
import { getIdleController } from '../idleController';
import { depthFor, labelsRegistry } from '../labelsOverlay';
import { repelLabels } from '../labelRepulsion';
import type { GraphSettings } from '../graphSettings';
import { isTextInput } from './refresh';

// Labels overlay: active while the user holds Alt. Shows the name of
// every node at `labelLevel` (path depth from the scan root); alt+wheel
// scrolls through depths so the user can read one band at a time.
//
// Track Alt as a chord-style modifier: keydown enables labels mode,
// keyup/blur disables. Alt+wheel cycles the visible depth band instead
// of zooming the camera.
export function useLabelsOverlay(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  containerRef: MutableRefObject<HTMLDivElement | null>,
  data: ScanResult | null,
  settingsRef: MutableRefObject<GraphSettings>,
) {
  const [labelMode, setLabelMode] = useState(false);
  const labelModeRef = useRef(false);
  const [labelLevel, setLabelLevel] = useState(1);
  const labelLevelRef = useRef(1);
  const maxDepthRef = useRef(0);
  const nodeDepthsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    labelModeRef.current = labelMode;
  }, [labelMode]);
  useEffect(() => {
    labelLevelRef.current = labelLevel;
  }, [labelLevel]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Alt') return;
      if (isTextInput(e.target)) return;
      if (e.repeat) return;
      // Browsers focus the menu bar on Alt-up; suppressing the default on
      // keydown also kills that side-effect when Alt is released alone.
      e.preventDefault();
      setLabelMode(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'Alt') setLabelMode(false);
    }
    function reset() {
      setLabelMode(false);
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

  // Alt+wheel intercept on the canvas: scroll up = shallower depth, scroll
  // down = deeper. Needs a non-passive listener so preventDefault actually
  // stops OrbitControls from zooming. deltaY is accumulated so a trackpad
  // (which fires many small-delta events per swipe) bumps depth one step at
  // a time instead of racing through every level in a single gesture.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let accum = 0;
    const STEP = 50;
    function onWheel(e: WheelEvent) {
      if (!e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      accum += e.deltaY;
      if (Math.abs(accum) < STEP) return;
      const dir = accum > 0 ? 1 : -1;
      accum = 0;
      setLabelLevel((lvl) => {
        const max = Math.max(1, maxDepthRef.current);
        const next = lvl + dir;
        if (next < 1) return 1;
        if (next > max) return max;
        return next;
      });
    }
    // Capture phase so we run before OrbitControls' canvas-level wheel
    // listener (which would otherwise zoom the camera before we get the
    // chance to call preventDefault).
    container.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () =>
      container.removeEventListener('wheel', onWheel, { capture: true });
  }, [containerRef]);

  // Recompute path depths whenever a new dataset arrives, plus the max
  // depth so alt+wheel can clamp to the visible range.
  useEffect(() => {
    if (!data) {
      nodeDepthsRef.current = new Map();
      maxDepthRef.current = 0;
      return;
    }
    const depths = new Map<string, number>();
    let maxD = 0;
    for (const n of data.nodes) {
      const d = depthFor(n, data.root);
      depths.set(n.id, d);
      if (d > maxD) maxD = d;
    }
    nodeDepthsRef.current = depths;
    maxDepthRef.current = maxD;
    setLabelLevel((lvl) => Math.min(Math.max(lvl, 1), Math.max(1, maxD)));
  }, [data]);

  // Refresh sprites when labels mode toggles or the active depth changes.
  useEffect(() => {
    labelsRegistry.clear();
    graphRef.current?.refresh?.();
  }, [labelMode, labelLevel, graphRef]);

  // Same physics as LOC, with a wider per-overlay base because file-name
  // labels are much longer than 3-digit LOC / health values and would
  // visibly overlap at 55 units. The `labelSpread` multiplier is read
  // fresh each tick so the slider takes effect live.
  useEffect(() => {
    if (!labelMode) return;
    // See `useHealthOverlay` for the always-running RAF pattern shared
    // by all three repulsion-driven overlays.
    const idle = getIdleController(graphRef.current);
    let rafId = 0;
    let stopped = false;

    idle?.acquireLabelPhysics();

    const tick = () => {
      if (stopped) return;
      repelLabels(labelsRegistry, 90 * settingsRef.current.labelSpread);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      idle?.releaseLabelPhysics();
    };
  }, [labelMode, settingsRef, graphRef]);

  return {
    labelMode,
    labelModeRef,
    labelLevel,
    labelLevelRef,
    maxDepthRef,
    nodeDepthsRef,
  };
}
