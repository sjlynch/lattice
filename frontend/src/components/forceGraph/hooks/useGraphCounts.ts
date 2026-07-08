import { useMemo, useRef } from 'react';
import type { ScanResult } from '../../../api';

export type GraphCounts = {
  files: number;
  dirs: number;
  hidden: number;
  loc: number;
};

// File / dir / hidden counts (+ total lines of code across the visible files)
// for the HUD chip. Keyed off the structural scan reference (stable across the
// metric-only HealthUpdates that churn `data` on every file save) + `hiddenExts`,
// so it no longer recomputes per save. The ref-compare reuses the prior object
// identity when the numbers are unchanged (e.g. a same-shape rescan), so the
// memoized HUD doesn't re-render needlessly.
//
// The LOC total is a metric field, so summing it off the structural ref means it
// lags one metric-patch cycle behind a single file save (it re-totals on the
// next structural rescan) — a deliberate, imperceptible staleness for a
// whole-project aggregate. Reading live `data` here instead would re-render the
// HUD on every save, defeating the very memo this hook exists to provide.
export function useGraphCounts(
  structuralData: ScanResult | null,
  hiddenExts: Set<string>,
): GraphCounts {
  const countsRef = useRef<GraphCounts>({ files: 0, dirs: 0, hidden: 0, loc: 0 });
  return useMemo(() => {
    let files = 0;
    let dirs = 0;
    let hidden = 0;
    let loc = 0;
    if (structuralData) {
      for (const n of structuralData.nodes) {
        if (n.kind === 'dir') {
          dirs++;
        } else {
          const key = n.ext ? n.ext.toLowerCase() : '*';
          if (hiddenExts.has(key)) hidden++;
          else {
            files++;
            // Sum LOC only over the visible files so the total matches the
            // `files` count the chip shows alongside it.
            loc += n.loc ?? 0;
          }
        }
      }
    }
    const prev = countsRef.current;
    if (
      prev.files === files &&
      prev.dirs === dirs &&
      prev.hidden === hidden &&
      prev.loc === loc
    ) {
      return prev;
    }
    const next = { files, dirs, hidden, loc };
    countsRef.current = next;
    return next;
  }, [structuralData, hiddenExts]);
}
