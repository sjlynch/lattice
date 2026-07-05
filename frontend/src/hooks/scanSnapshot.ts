import type { Dispatch, SetStateAction } from 'react';
import type { ScanResult } from '../api';

// State-shape helpers for the project-scan snapshot: the `{ root, result,
// loading }` value the scheduler pushes into React state. These are pure — no
// timers, subscriptions, or request fencing (those live in `scanRetry` /
// `healthUpdateScheduler`). Splitting them out lets both scan effects share one
// definition of what the snapshot looks like in each phase.

export type ProjectScanSnapshot = {
  root: string;
  result: ScanResult | null;
  loading: boolean;
};

export const EMPTY_SCAN_SNAPSHOT: ProjectScanSnapshot = {
  root: '',
  result: null,
  loading: false,
};

export function snapshotForInitialScan(root: string): ProjectScanSnapshot {
  return { root, result: null, loading: true };
}

export function snapshotForScanResult(root: string, result: ScanResult): ProjectScanSnapshot {
  return { root, result, loading: false };
}

// Apply an in-place patch to the current result, but only while the snapshot
// still belongs to `root` (guards against a late metric flush landing on a
// project we've already switched away from). Returns the same reference on a
// no-op so React skips the render.
export function patchSnapshot(
  root: string,
  setSnapshot: Dispatch<SetStateAction<ProjectScanSnapshot>>,
  patch: (prev: ScanResult) => ScanResult,
) {
  setSnapshot((prev) => {
    if (prev.root !== root || !prev.result) return prev;
    const next = patch(prev.result);
    return next === prev.result ? prev : { ...prev, result: next };
  });
}
