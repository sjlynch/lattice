import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchUserSettings, patchUserSettings } from '../../../api';

// Per-step collapse state, keyed by step id. Persisted in the project's
// userSettings.json under workflowStepsCollapsed so collapse/expand state
// survives reloads. Only `true` entries are persisted to keep the file
// tidy — a missing key means expanded.
//
// A *newly added* step is collapsed instead: the editor calls `collapseSteps`
// with the new step's id as it adds it, so building a workflow out of quick-add
// chips yields a compact list of step headers rather than a wall of prompt
// textareas. Expanding one drops its key again (back to the map default), which
// is why the default itself stays "expanded" — flipping it would retroactively
// collapse every step of every existing workflow.
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

  // Fire-and-forget — collapsing shouldn't block the UI. PATCH merges
  // server-side so concurrent writes from another tab won't clobber unrelated
  // settings. Skipped until this folder's settings have loaded so we never
  // write back over state we haven't read yet.
  const persist = useCallback(
    (next: Record<string, boolean>) => {
      if (!activeFolder || collapsedLoadedForRef.current !== activeFolder) return;
      void patchUserSettings(activeFolder, {
        workflowStepsCollapsed: next,
      }).catch(() => { /* best-effort persistence */ });
    },
    [activeFolder],
  );

  const toggleCollapsed = useCallback(
    (stepId: string) => {
      setCollapsedSteps((cur) => {
        // Only `true` entries are stored; flipping back to false drops the
        // key so the file doesn't grow with stale step ids.
        const next = { ...cur };
        if (next[stepId]) delete next[stepId];
        else next[stepId] = true;
        persist(next);
        return next;
      });
    },
    [persist],
  );

  // Mark freshly created steps collapsed. Called by the editor's add actions
  // (Add step / quick-add chip / template / new blank) with the ids of the
  // agent steps they just appended.
  const collapseSteps = useCallback(
    (stepIds: string[]) => {
      if (stepIds.length === 0) return;
      setCollapsedSteps((cur) => {
        if (stepIds.every((id) => cur[id])) return cur;
        const next = { ...cur };
        for (const id of stepIds) next[id] = true;
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const isCollapsed = useCallback(
    (stepId: string) => !!collapsedSteps[stepId],
    [collapsedSteps],
  );

  return { collapsedSteps, isCollapsed, toggleCollapsed, collapseSteps };
}
