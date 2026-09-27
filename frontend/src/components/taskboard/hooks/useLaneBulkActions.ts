import { useEffect, useMemo } from 'react';
import { type Task, type TaskStatus } from '../../../api';
import { useBulkRunStrips } from './useBulkRunStrips';

// The lane "run all" callbacks this hook assembles into the per-lane action map.
// Open/In-Progress/QA return the ids they targeted so a bulk strip can track
// against them; Ready-to-Merge drives its own backend merge-run strip, so it's
// wired in verbatim.
type LaneRunAllActions = {
  runAllOpen: () => string[];
  resumeAllInProgress: () => string[];
  mergeAllReady: () => void;
  markAllQaDone: () => string[];
};

type UseLaneBulkActionsArgs = LaneRunAllActions & {
  // The strips reset on a project switch (see `useBulkRunStrips`).
  activeFolder: string;
  tasks: Task[];
  // Bridges `useBulkRunStrips`' `noteBulkSpawned` back to the task-spawned
  // handler (declared earlier, before the task list this hook needs). Resume has
  // no task-state signal, so its strip completes off `task-spawned`.
  setBulkSpawnNotifier: (notify: (taskId: string) => void) => void;
};

// Owns the Open/In-Progress/QA bulk-run progress strips and builds the per-lane
// "run all" action map the lane grid renders. Pulls the strip wiring + the
// run-all-vs-merge-all assembly out of the launcher so it stays panel/layout
// composition.
export function useLaneBulkActions({
  activeFolder,
  tasks,
  setBulkSpawnNotifier,
  runAllOpen,
  resumeAllInProgress,
  mergeAllReady,
  markAllQaDone,
}: UseLaneBulkActionsArgs) {
  const { bulkStrips, beginBulk, noteBulkSpawned, dismissBulk } =
    useBulkRunStrips(activeFolder, tasks);

  // Hand the spawn handler the resume strip's notifier once it exists.
  useEffect(() => {
    setBulkSpawnNotifier(noteBulkSpawned);
  }, [setBulkSpawnNotifier, noteBulkSpawned]);

  // Fire the bulk action and start its progress strip off the ids it targeted
  // (merge-all keeps its own backend-run strip via mergeRunStripFor).
  const runAllActionByLane = useMemo<Partial<Record<TaskStatus, () => void>>>(
    () => ({
      open: () => beginBulk('open', runAllOpen(), 'run'),
      in_progress: () =>
        beginBulk('in_progress', resumeAllInProgress(), 'resume'),
      ready_to_merge: mergeAllReady,
      qa: () => beginBulk('qa', markAllQaDone(), 'qa-done'),
    }),
    [beginBulk, runAllOpen, resumeAllInProgress, mergeAllReady, markAllQaDone],
  );

  return { runAllActionByLane, bulkStrips, dismissBulk };
}
