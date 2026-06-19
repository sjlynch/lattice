import { useCallback, useEffect, useState } from 'react';
import type { TaskStatus } from '../../../api';
import { DEFAULT_LANE_SORT, type LaneSortMode } from '../laneSort';

type LaneSortState = Partial<Record<TaskStatus, LaneSortMode>>;

// Per-project, matching the `lattice.<thing>.<projectPath>` convention.
const STORAGE_PREFIX = 'lattice.laneSort.';

function load(project: string): LaneSortState {
  if (!project) return {};
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + project);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as LaneSortState) : {};
  } catch {
    return {};
  }
}

// Holds each lane's clock/caret sort mode (default 'recent' = newest arrival on
// top), persisted per project. `toggle` flips recent↔oldest (and re-activates
// arrival sort from a manual lane); `setManual` is called when a drag drops a
// card at an explicit slot so the user's hand-ordering wins until they re-sort.
export function useLaneSort(project: string) {
  const [state, setState] = useState<LaneSortState>(() => load(project));

  useEffect(() => {
    setState(load(project));
  }, [project]);

  useEffect(() => {
    if (!project) return;
    try {
      localStorage.setItem(STORAGE_PREFIX + project, JSON.stringify(state));
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [project, state]);

  const getMode = useCallback(
    (lane: TaskStatus): LaneSortMode => state[lane] ?? DEFAULT_LANE_SORT,
    [state],
  );

  const toggle = useCallback((lane: TaskStatus) => {
    setState((prev) => {
      const cur = prev[lane] ?? DEFAULT_LANE_SORT;
      const next: LaneSortMode = cur === 'recent' ? 'oldest' : 'recent';
      return { ...prev, [lane]: next };
    });
  }, []);

  const setManual = useCallback((lane: TaskStatus) => {
    setState((prev) =>
      prev[lane] === 'manual' ? prev : { ...prev, [lane]: 'manual' },
    );
  }, []);

  return { getMode, toggle, setManual };
}
