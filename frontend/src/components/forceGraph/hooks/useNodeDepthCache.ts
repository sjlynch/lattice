import { useEffect, useRef } from 'react';
import type { ScanResult } from '../../../api';
import { depthFor } from '../labelsOverlay';
import { depthMapStructuralKey } from '../depthMap';

// Cached path-depth map for the Alt-label overlay, keyed off a cheap structural
// fingerprint of the dataset so the costly recompute is skipped on the metric-
// only HealthUpdate bursts that dominate `data` ref churn.
//
// Returns the refs `useLabelsOverlay` reads: `nodeDepthsRef` (id → path depth),
// `maxDepthRef` (deepest node overall, files included), `maxDirDepthRef`
// (deepest *directory*), and the internal `structuralKeyRef` (the fingerprint
// the cache was last built from — exposed so the consumer can detect a rebuild
// if ever needed; today only this hook writes it).
export function useNodeDepthCache(data: ScanResult | null) {
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
  // changes all shift the fingerprint and so still rebuild.
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
  }, [data]);

  return { nodeDepthsRef, maxDepthRef, maxDirDepthRef, structuralKeyRef };
}
