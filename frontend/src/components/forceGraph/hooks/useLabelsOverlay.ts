import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../../api';
import {
  labelsRegistry,
  LABEL_REPULSION_BASE,
  releaseNameLabelEntry,
} from '../labelsOverlay';
import { applyLabelsToGraph } from '../labelSync';
import { startLabelRepulsion } from '../labelRepulsionFrames';
import { getIdleController } from '../idleController';
import type { GraphSettings } from '../graphSettings';
import { useHoldKeyMode } from './useHoldKeyMode';
import { useNodeDepthCache } from './useNodeDepthCache';

// Alt+wheel deltaY accumulated past this threshold bumps the depth band one
// step. Trackpads fire many small-delta events per swipe, so accumulating to a
// threshold advances one level per gesture instead of racing through every band.
const WHEEL_DEPTH_STEP = 50;

// Labels overlay: active while the user holds Alt OR while the Labels view is
// pinned (the overlay-key chip latches the same state). Shows the name of
// every node at `labelLevel` (path depth from the scan root); alt+wheel
// scrolls through depths so the user can read one band at a time.
//
// Track Alt as a chord-style modifier: keydown enables labels mode,
// keyup/blur disables. Alt+wheel cycles the visible depth band instead
// of zooming the camera. The Shift sub-gate and alt+wheel depth scroll only
// apply while Alt is physically held; a pin shows directory names at the
// current depth (hold Alt to scroll depths / reveal file labels).
export function useLabelsOverlay(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  containerRef: MutableRefObject<HTMLDivElement | null>,
  data: ScanResult | null,
  settingsRef: MutableRefObject<GraphSettings>,
  // The user's current node selection. When non-empty, holding Alt shows the
  // labels of exactly these nodes and no others (depth band + Shift ignored).
  selected: Set<string>,
  pinned: boolean,
  // True while a recolor view (health `h` / loc `z` / dead `d`) owns the
  // sprites. `decideSpriteState` already suppresses Alt labels under a metric
  // view on the full-rebuild path; the in-place delta below has to apply the
  // same gate, or "hold H, then Alt" stacks labels on the recolored sprites
  // while the other order strips them.
  metricOverlayActive: boolean,
) {
  // `labelHeld` tracks just the Alt key; the effective mode is held OR pinned.
  const [labelHeld, setLabelHeld] = useState(false);
  const labelMode = labelHeld || pinned;
  const labelModeRef = useRef(false);
  // Whether Shift is also held while Alt is down — gates file-node labels.
  // Alt alone shows only directory names.
  const [labelShift, setLabelShift] = useState(false);
  const labelShiftRef = useRef(false);
  const [labelLevel, setLabelLevel] = useState(1);
  const labelLevelRef = useRef(1);
  // Cached path-depth map + the deepest-node / deepest-directory ceilings the
  // alt+wheel clamps against. Owned by `useNodeDepthCache`, which rebuilds them
  // only when `data` is *structurally* new (metric-only HealthUpdate bursts
  // reuse the cache). `maxDepthRef` is the full depth (Shift held → file labels
  // reachable); `maxDirDepthRef` the deepest *directory* (Alt alone → dir names
  // only, so scrolling past it would land on empty file-only bands).
  const { nodeDepthsRef, maxDepthRef, maxDirDepthRef } = useNodeDepthCache(data);

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

  // Alt isn't a single-letter momentary chord (it's a modifier, with a Shift
  // sub-gate and a `preventDefault` for the menu-bar focus side effect), so it
  // supplies bespoke handlers to the shared lifecycle rather than
  // `momentaryLetterMode`. `useHoldKeyMode` still owns the four listeners, the
  // text-input guard, and the blur/visibility reset.
  useHoldKeyMode({
    onKeyDown(e) {
      if (e.key === 'Alt') {
        if (e.repeat) return;
        // Browsers focus the menu bar on Alt-up; suppressing the default on
        // keydown also kills that side-effect when Alt is released alone.
        e.preventDefault();
        setLabelHeld(true);
        // Pick up Shift if it's already held as Alt goes down.
        setLabelShift(e.shiftKey);
        return;
      }
      // Shift only matters while the labels overlay is up — gate on the live
      // Alt state so unrelated Shift use (e.g. shift-drag box-select) doesn't
      // flip the file-label gate and trigger a sprite refresh.
      if (e.key === 'Shift' && e.altKey) setLabelShift(true);
    },
    onKeyUp(e) {
      if (e.key === 'Alt') {
        setLabelHeld(false);
        setLabelShift(false);
      } else if (e.key === 'Shift') {
        setLabelShift(false);
      }
    },
    onReset() {
      setLabelHeld(false);
      setLabelShift(false);
    },
  });

  // Alt+wheel intercept on the canvas: scroll up = shallower depth, scroll
  // down = deeper. Needs a non-passive listener so preventDefault actually
  // stops OrbitControls from zooming. deltaY is accumulated so a trackpad
  // (which fires many small-delta events per swipe) bumps depth one step at
  // a time instead of racing through every level in a single gesture.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let accum = 0;
    function onWheel(e: WheelEvent) {
      if (!e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      accum += e.deltaY;
      if (Math.abs(accum) < WHEEL_DEPTH_STEP) return;
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

  // Re-clamp the active level to the depth cache's (possibly new) ceiling on a
  // dataset change. `useNodeDepthCache` rebuilds the ceiling refs from a `[data]`
  // effect declared earlier (so it fires first), and this reads them.
  //
  // Only write state when the level actually changes: a metric-only update
  // leaves the ceiling untouched, so the clamp is a no-op — skipping the
  // `setLabelLevel` avoids a redundant React state write + the downstream
  // label-repaint effect on every health burst. A null `data` keeps the level as
  // is (matching the cache hook's early reset, which never re-clamps).
  useEffect(() => {
    if (!data) return;
    const clamped = Math.min(
      Math.max(labelLevelRef.current, 1),
      effectiveMaxDepth(labelShiftRef.current),
    );
    if (clamped !== labelLevelRef.current) setLabelLevel(clamped);
  }, [data]);

  // Releasing Shift drops the ceiling to the deepest directory; snap the level
  // down so labels stay visible instead of landing on an empty file-only band.
  // Pressing Shift only raises the ceiling, so it never needs a clamp.
  useEffect(() => {
    if (labelShift) return;
    setLabelLevel((lvl) => Math.min(lvl, effectiveMaxDepth(false)));
  }, [labelShift]);

  // Toggle labels in place when labels mode flips, the active depth changes,
  // Shift is pressed/released, or the selection changes (so narrowing to the
  // selected nodes — or back to depth bands when it clears — repaints live while
  // Alt is held). Instead of `graph.refresh()` — which disposes and rebuilds
  // *every* node sprite — `applyLabelsToGraph` walks the mounted nodes and
  // adds/removes only the labels that changed (see `labelSync`). The idle
  // controller is woken so the scene change paints; the d3 engine is untouched.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    // Same gate as `decideSpriteState`: no Alt labels while a metric view owns
    // the sprites. The metric flag is a dep so releasing the view re-syncs.
    const enabled = labelMode && !metricOverlayActive;
    // This effect also re-runs on every selection change. With labels off and
    // none mounted there is nothing to reconcile — skip the O(N) walk and the
    // ~120 ms of frames `wakeForRefresh` would otherwise burn per click.
    if (!enabled && labelsRegistry.size === 0) return;
    applyLabelsToGraph(
      graph,
      nodeDepthsRef.current,
      settingsRef.current,
      labelLevel,
      labelShift,
      enabled,
      selected,
    );
    getIdleController(graph)?.wakeForRefresh();
  }, [
    labelMode,
    metricOverlayActive,
    labelShift,
    labelLevel,
    selected,
    graphRef,
    settingsRef,
  ]);

  // Same physics as LOC/health, but with the wider `LABEL_REPULSION_BASE`
  // because file-name labels are much longer than the 3-digit LOC / health
  // values and would visibly overlap at the metric overlays'
  // `METRIC_REPULSION_BASE`. The `labelSpread` multiplier is read fresh each
  // tick so the slider takes effect live. Shared frame-driven, rest-gated loop
  // — see `labelRepulsionFrames`.
  useEffect(() => {
    if (!labelMode) return;
    return startLabelRepulsion(
      graphRef.current,
      labelsRegistry,
      () => LABEL_REPULSION_BASE * settingsRef.current.labelSpread,
      releaseNameLabelEntry,
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
