import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { clearLabelsAndRefresh } from './refresh';

// Re-render node THREE objects when the LOC/health ignore list changes so the
// new filter takes effect without touching the d3 simulation. Skips the mount
// run: the initial sprite build already reads the ignore set (threaded as
// `metricsIgnoredExtsRef` into useForceGraphInitialization), so a refresh here
// on first mount is a wasted full sprite rebuild + loop wake — often before any
// data has even loaded.
export function useMetricsIgnoreRefresh(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  metricsIgnoredExtsSet: Set<string>,
): void {
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    clearLabelsAndRefresh(graphRef.current);
  }, [metricsIgnoredExtsSet, graphRef]);
}
