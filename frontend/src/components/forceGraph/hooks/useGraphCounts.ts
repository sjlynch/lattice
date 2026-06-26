import { useMemo, useRef } from 'react';
import type { ScanResult } from '../../../api';

export type GraphCounts = { files: number; dirs: number; hidden: number };

// File / dir / hidden counts for the HUD chip. Keyed off the structural scan
// reference (stable across the metric-only HealthUpdates that churn `data` on
// every file save) + `hiddenExts`, so it no longer recomputes per save. The
// ref-compare reuses the prior object identity when the three numbers are
// unchanged (e.g. a same-shape rescan), so the memoized HUD doesn't re-render
// needlessly.
export function useGraphCounts(
  structuralData: ScanResult | null,
  hiddenExts: Set<string>,
): GraphCounts {
  const countsRef = useRef<GraphCounts>({ files: 0, dirs: 0, hidden: 0 });
  return useMemo(() => {
    let files = 0;
    let dirs = 0;
    let hidden = 0;
    if (structuralData) {
      for (const n of structuralData.nodes) {
        if (n.kind === 'dir') {
          dirs++;
        } else {
          const key = n.ext ? n.ext.toLowerCase() : '*';
          if (hiddenExts.has(key)) hidden++;
          else files++;
        }
      }
    }
    const prev = countsRef.current;
    if (prev.files === files && prev.dirs === dirs && prev.hidden === hidden) {
      return prev;
    }
    const next = { files, dirs, hidden };
    countsRef.current = next;
    return next;
  }, [structuralData, hiddenExts]);
}
