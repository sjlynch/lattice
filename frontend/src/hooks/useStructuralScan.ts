import { useMemo } from 'react';
import type { ScanResult } from '../api';

// Returns a `ScanResult` reference that changes identity only when the file
// *structure* changes (files added/removed/renamed, a fresh rescan), NOT on a
// metric-only HealthUpdate.
//
// `data` gets a brand-new reference on every backend HealthUpdate (one per file
// save while the dev server churns). But the metric-patch helpers in
// `scanResultPatch.ts` deliberately preserve the `links` array identity — only
// a structural change (removal/add, or a fresh `scanFolder` response) rebuilds
// `links`. So keying a memo on `links` identity yields a reference that stays
// stable across metric churn, letting structure-only consumers (file/dir
// counts, legend rows, filename search, project-stack detection) skip the O(N)
// recompute + re-render that every file save would otherwise force.
//
// The returned value carries *stale metric fields* by design — only feed it to
// consumers that read structural fields (kind/ext/name/path/id). Anything that
// renders health/loc/size must keep depending on the live `data`.
export function useStructuralScan(data: ScanResult | null): ScanResult | null {
  const links = data?.links;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => data, [links]);
}
