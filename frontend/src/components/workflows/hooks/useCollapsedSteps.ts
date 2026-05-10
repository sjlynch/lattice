import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchUserSettings, patchUserSettings } from '../../../api';

// Per-step collapse state, keyed by step id. Persisted in the project's
// userSettings.json under workflowStepsCollapsed so collapse/expand state
// survives reloads. Only `true` entries are persisted to keep the file
// tidy — a missing key means expanded (the default).
export function useCollapsedSteps(activeFolder: string) {
  const [collapsedSteps, setCollapsedSteps] = useState<Record<string, boolean>>({});
  // Track which folder we've already loaded settings for so swapping
  // projects doesn't keep stale collapse data and so we can skip writing
  // back the same value we just read on the very first PATCH.
  const collapsedLoadedForRef = useRef<string | null>(null);

  // Load persisted collapse state when the active folder changes.
  useEffect(() => {
    if (!activeFolder) {
      setCollapsedSteps({});
      collapsedLoadedForRef.current = null;
      return;
    }
    let cancelled = false;
    fetchUserSettings(activeFolder)
      .then((s) => {
        if (cancelled) return;
        setCollapsedSteps(s.workflowStepsCollapsed ?? {});
        collapsedLoadedForRef.current = activeFolder;
      })
      .catch(() => { /* keep default */ });
    return () => { cancelled = true; };
  }, [activeFolder]);

  const toggleCollapsed = useCallback(
    (stepId: string) => {
      setCollapsedSteps((cur) => {
        // Only `true` entries are stored; flipping back to false drops the
        // key so the file doesn't grow with stale step ids.
        const next = { ...cur };
        if (next[stepId]) delete next[stepId];
        else next[stepId] = true;
        if (activeFolder && collapsedLoadedForRef.current === activeFolder) {
          // Fire-and-forget — toggling shouldn't block the UI. PATCH merges
          // server-side so concurrent writes from another tab won't clobber
          // unrelated settings.
          void patchUserSettings(activeFolder, {
            workflowStepsCollapsed: next,
          }).catch(() => { /* best-effort persistence */ });
        }
        return next;
      });
    },
    [activeFolder],
  );

  const isCollapsed = useCallback(
    (stepId: string) => !!collapsedSteps[stepId],
    [collapsedSteps],
  );

  return { collapsedSteps, isCollapsed, toggleCollapsed };
}
