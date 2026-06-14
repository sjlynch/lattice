import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../../api';
import { depthFor, labelsRegistry } from '../labelsOverlay';
import { applyLabelsToGraph } from '../labelSync';
import { startLabelRepulsion } from '../labelRepulsionFrames';
import { getIdleController } from '../idleController';
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
  // Whether Shift is also held while Alt is down — gates file-node labels.
  // Alt alone shows only directory names.
  const [labelShift, setLabelShift] = useState(false);
  const labelShiftRef = useRef(false);
  const [labelLevel, setLabelLevel] = useState(1);
  const labelLevelRef = useRef(1);
  // Deepest node overall (files included) and deepest *directory*. The wheel
  // clamps to whichever applies: with Shift held file labels show, so the full
  // depth is reachable; with Alt alone only directory names show, so scrolling
  // past the deepest directory would land on empty (file-only) bands. Clamping
  // to the dir max keeps a label visible at every reachable level.
  const maxDepthRef = useRef(0);
  const maxDirDepthRef = useRef(0);
  const nodeDepthsRef = useRef<Map<string, number>>(new Map());

  // Effective ceiling for the current modifier state.
  const effectiveMaxDepth = (shift: boolean) =>
    Math.max(1, shift ? maxDepthRef.current : maxDirDepthRef.current);

  useEffect(() => {
    labelModeRef.current = labelMode;
  }, [labelMode]);
  useEffect(() => {
    labelShiftRef.current = labelShift;
  }, [labelShift]);
  useEffect(() => {
    labelLevelRef.current = labelLevel;
  }, [labelLevel]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTextInput(e.target)) return;
      if (e.key === 'Alt') {
        if (e.repeat) return;
        // Browsers focus the menu bar on Alt-up; suppressing the default on
        // keydown also kills that side-effect when Alt is released alone.
        e.preventDefault();
        setLabelMode(true);
        // Pick up Shift if it's already held as Alt goes down.
        setLabelShift(e.shiftKey);
        return;
      }
      // Shift only matters while the labels overlay is up — gate on the live
      // Alt state so unrelated Shift use (e.g. shift-drag box-select) doesn't
      // flip the file-label gate and trigger a sprite refresh.
      if (e.key === 'Shift' && e.altKey) setLabelShift(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'Alt') {
        setLabelMode(false);
        setLabelShift(false);
      } else if (e.key === 'Shift') {
        setLabelShift(false);
      }
    }
    function reset() {
      setLabelMode(false);
      setLabelShift(false);
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
        const max = effectiveMaxDepth(labelShiftRef.current);
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
      maxDirDepthRef.current = 0;
      return;
    }
    const depths = new Map<string, number>();
    let maxD = 0;
    let maxDirD = 0;
    for (const n of data.nodes) {
      const d = depthFor(n, data.root);
      depths.set(n.id, d);
      if (d > maxD) maxD = d;
      if (n.kind === 'dir' && d > maxDirD) maxDirD = d;
    }
    nodeDepthsRef.current = depths;
    maxDepthRef.current = maxD;
    maxDirDepthRef.current = maxDirD;
    setLabelLevel((lvl) =>
      Math.min(Math.max(lvl, 1), effectiveMaxDepth(labelShiftRef.current)),
    );
  }, [data]);

  // Releasing Shift drops the ceiling to the deepest directory; snap the level
  // down so labels stay visible instead of landing on an empty file-only band.
  // Pressing Shift only raises the ceiling, so it never needs a clamp.
  useEffect(() => {
    if (labelShift) return;
    setLabelLevel((lvl) => Math.min(lvl, effectiveMaxDepth(false)));
  }, [labelShift]);

  // Toggle labels in place when labels mode flips, the active depth changes, or
  // Shift is pressed/released. Instead of `graph.refresh()` — which disposes and
  // rebuilds *every* node sprite — `applyLabelsToGraph` walks the mounted nodes
  // and adds/removes only the labels that changed (see `labelSync`). The idle
  // controller is woken so the scene change paints; the d3 engine is untouched.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    applyLabelsToGraph(
      graph,
      nodeDepthsRef.current,
      settingsRef.current,
      labelLevel,
      labelShift,
      labelMode,
    );
    getIdleController(graph)?.wakeForRefresh();
  }, [labelMode, labelShift, labelLevel, graphRef, settingsRef]);

  // Same physics as LOC, with a wider per-overlay base because file-name
  // labels are much longer than 3-digit LOC / health values and would
  // visibly overlap at 55 units. The `labelSpread` multiplier is read
  // fresh each tick so the slider takes effect live.
  useEffect(() => {
    if (!labelMode) return;
    // Wider per-overlay base (90 units) because file-name labels are much longer
    // than 3-digit LOC/health values. Shared frame-driven, rest-gated loop — see
    // `labelRepulsionFrames`.
    return startLabelRepulsion(
      graphRef.current,
      labelsRegistry,
      () => 90 * settingsRef.current.labelSpread,
    );
  }, [labelMode, settingsRef, graphRef]);

  return {
    labelMode,
    labelModeRef,
    labelShift,
    labelShiftRef,
    labelLevel,
    labelLevelRef,
    maxDepthRef,
    maxDirDepthRef,
    nodeDepthsRef,
  };
}
