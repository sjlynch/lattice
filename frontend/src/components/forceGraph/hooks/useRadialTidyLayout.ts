import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../../api';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { computeRadialTidyLayout } from '../radialTidyLayout';
import { useRefMirror } from './useRefMirror';

// Defer the reheat one macrotask so kapsule's debounced first digest has
// installed the layout — same guard usePhysicsAndRepulsionSettings uses against
// the "state.layout undefined" first-tick crash.
const REHEAT_DEFER_MS = 50;

// The on-load untangler. The file scan is a containment *tree*, and the
// library's default phyllotaxis-spiral seed ignores that tree — sibling
// subtrees start interleaved and the engine settles them into a tangled "cord
// nest". Instead we seed each node at its **radial tidy-tree** position
// (`../radialTidyLayout`): every subtree gets its own angular wedge sized by its
// leaf count, radius growing with directory depth. Sibling wedges never overlap,
// so the seed is effectively planar; the engine then settles *from* it, which
// preserves the angular separation (the forces are radially symmetric) while the
// global charge declumps each directory's file cluster into 2D area.
//
// Runs once per project on first data populate (and on demand via the returned
// `runLayout`, wired to the Spread tab's "Untangle now" button). A per-project
// guard stops file-save re-scans from re-flinging a graph the user has since
// arranged. Auto-run is gated on `tidyLayoutOnLoad`; the manual trigger always
// runs.
export function useRadialTidyLayout(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  structuralData: ScanResult | null,
  settingsRef: MutableRefObject<GraphSettings>,
  activeFolder: string,
): () => void {
  const structuralRef = useRefMirror(structuralData);
  const reheatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The project we've already auto-untangled, so structural churn (every file
  // save re-pushes the scan) doesn't re-seed — only the first populate does.
  const seededKeyRef = useRef<string | null>(null);

  const clearTimer = useCallback(() => {
    if (reheatTimerRef.current) {
      clearTimeout(reheatTimerRef.current);
      reheatTimerRef.current = null;
    }
  }, []);

  const runLayout = useCallback(() => {
    const g = graphRef.current;
    if (!g || !structuralRef.current || structuralRef.current.nodes.length === 0)
      return;

    // The seed is applied *inside* the deferred callback — not here — and the
    // reheat fires synchronously right after it, in the same macrotask. The
    // defer (REHEAT_DEFER_MS) lets kapsule's debounced first digest install
    // `state.layout` before we reheat (else the first reheat crashes in
    // layoutTick — the same guard the physics effect uses). The reason apply +
    // reheat must be *atomic* (back-to-back, no engine frame between): on load
    // the engine is hot from the data-load reheat, so if the seed is written and
    // the reheat is left for a later frame, the strong center repulsion scatters
    // the crowded shallow nodes in the intervening frames — scrambling the
    // angular wedges and re-tangling the graph. Writing the seed then reheating
    // synchronously (which resets alpha and we've zeroed velocities) makes the
    // engine's next tick start cleanly from the seed.
    clearTimer();
    reheatTimerRef.current = setTimeout(() => {
      reheatTimerRef.current = null;
      const gg = graphRef.current;
      const data = structuralRef.current;
      if (gg !== g || !data || data.nodes.length === 0) return;
      const s = settingsRef.current;

      const positions = computeRadialTidyLayout(data, {
        spread: s.tidySpread,
        linkDistance: s.linkDistance,
        dagLevelDistance: s.dagLevelDistance,
      });
      if (positions.size === 0) return;

      // Write the seed onto the live sim nodes and zero their velocities so the
      // reheat relaxes from rest, not stale momentum. Y is left untouched
      // (pinned by the DAG via `fy`).
      const nodes = (gg.graphData().nodes ?? []) as Array<{
        id: string;
        x?: number;
        z?: number;
        vx?: number;
        vz?: number;
      }>;
      let applied = 0;
      for (const n of nodes) {
        const p = positions.get(n.id);
        if (!p) continue;
        n.x = p.x;
        n.z = p.z;
        n.vx = 0;
        n.vz = 0;
        applied++;
      }
      if (applied === 0) return;

      gg.d3ReheatSimulation();
      getIdleController(gg)?.engineStarted();
    }, REHEAT_DEFER_MS);
  }, [graphRef, structuralRef, settingsRef, clearTimer]);

  // Auto-untangle once per project, the first time its structural data
  // populates — unless the user has turned the on-load untangle off.
  useEffect(() => {
    if (seededKeyRef.current === activeFolder) return;
    if (!structuralData || structuralData.nodes.length === 0) return;
    seededKeyRef.current = activeFolder; // mark attempted (don't re-eval per save)
    if (settingsRef.current.tidyLayoutOnLoad) runLayout();
  }, [structuralData, activeFolder, runLayout, settingsRef]);

  // Cancel a pending reheat on project switch / unmount.
  useEffect(() => () => clearTimer(), [activeFolder, clearTimer]);

  return runLayout;
}
