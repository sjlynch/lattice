import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../../api';
import { depthFor, labelsRegistry, LABEL_REPULSION_BASE } from '../labelsOverlay';
import { applyLabelsToGraph } from '../labelSync';
import { startLabelRepulsion } from '../labelRepulsionFrames';
import { getIdleController } from '../idleController';
import type { GraphSettings } from '../graphSettings';
import { useHoldKeyMode } from './useHoldKeyMode';

// FNV-1a (32-bit) hash constants for `depthMapStructuralKey` below: the standard
// offset basis (seed) and prime. `FNV_SEPARATOR` is the delimiter byte mixed in
// between hashed entries so e.g. ['ab','c'] and ['a','bc'] can't collide; its
// value (0x2f, '/') is arbitrary — only that it's a consistent separator matters.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const FNV_SEPARATOR = 0x2f;

// Alt+wheel deltaY accumulated past this threshold bumps the depth band one
// step. Trackpads fire many small-delta events per swipe, so accumulating to a
// threshold advances one level per gesture instead of racing through every band.
const WHEEL_DEPTH_STEP = 50;

// Cheap structural fingerprint of the inputs the Alt-label depth map depends on:
// the scan root plus the node-id set (a metric-only health/LOC update keeps both
// identical — only per-node `health`/`loc` fields change). A new `data` ref whose
// fingerprint is unchanged reuses the cached depth map instead of re-walking
// every path with `depthFor`. Node id === path for real nodes, so any add /
// remove / rename — the only things that move a depth — shifts the count or an
// id and so the key.
function depthMapStructuralKey(data: ScanResult): string {
  // FNV-1a rolling hash over the root then every node id, with a separator byte
  // mixed in between entries (so ['ab','c'] and ['a','bc'] can't collide). No
  // substring allocation, no Map build — unlike the depth recompute it guards.
  let h = FNV_OFFSET_BASIS;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h = (h ^ s.charCodeAt(i)) >>> 0;
      h = (h * FNV_PRIME) >>> 0;
    }
    h = ((h ^ FNV_SEPARATOR) * FNV_PRIME) >>> 0;
  };
  mix(data.root);
  for (const n of data.nodes) mix(n.id);
  // Node count is folded in too as a cheap extra guard against a hash collision.
  return `${data.nodes.length}:${h >>> 0}`;
}

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
  // The user's current node selection. When non-empty, holding Alt shows the
  // labels of exactly these nodes and no others (depth band + Shift ignored).
  selected: Set<string>,
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
  // Structural fingerprint of the data the depth map was last built from, so a
  // metric-only `data` ref (same nodes/root) reuses the cached map (see below).
  const structuralKeyRef = useRef<string | null>(null);

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
        setLabelMode(true);
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
        setLabelMode(false);
        setLabelShift(false);
      } else if (e.key === 'Shift') {
        setLabelShift(false);
      }
    },
    onReset() {
      setLabelMode(false);
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

  // Recompute path depths whenever a *structurally* new dataset arrives, plus
  // the max depth so alt+wheel can clamp to the visible range.
  //
  // The `data` ScanResult ref changes on every backend HealthUpdate (a file save
  // → re-scan with one node's metrics patched), but those metric-only updates
  // keep the same node ids and root — the depth map cannot have changed. Walking
  // every node through `depthFor` (an O(N × pathLen) string scan) on each of
  // those bursts is pure waste, so guard the rebuild on a cheap structural
  // fingerprint and reuse the cached `nodeDepthsRef`/`maxDepthRef`/
  // `maxDirDepthRef` when it's unchanged. Added/removed/renamed files and root
  // changes all shift the fingerprint and so still rebuild + re-clamp.
  useEffect(() => {
    if (!data) {
      nodeDepthsRef.current = new Map();
      maxDepthRef.current = 0;
      maxDirDepthRef.current = 0;
      structuralKeyRef.current = null;
      return;
    }
    const key = depthMapStructuralKey(data);
    if (key !== structuralKeyRef.current) {
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
      structuralKeyRef.current = key;
    }
    // Re-clamp the active level to the (possibly new) ceiling, but only write
    // state when it actually changes. A metric-only update leaves the ceiling
    // untouched, so the clamp is a no-op — skipping the `setLabelLevel` avoids a
    // redundant React state write + the downstream label-repaint effect on every
    // health burst.
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
    applyLabelsToGraph(
      graph,
      nodeDepthsRef.current,
      settingsRef.current,
      labelLevel,
      labelShift,
      labelMode,
      selected,
    );
    getIdleController(graph)?.wakeForRefresh();
  }, [labelMode, labelShift, labelLevel, selected, graphRef, settingsRef]);

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
