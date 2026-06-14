import type { ReactNode } from 'react';
import type { MergeRun, Task } from '../../api';
import type { Lane as LaneDef } from './lanes';
import {
  ActiveStrip,
  ResolvingStrip,
  SummaryStrip,
} from './MergeRunStripStates';

export function mergeRunStripFor(
  lane: LaneDef,
  laneTasks: Task[],
  mergeRun: MergeRun | null,
  recentRunSummary: MergeRun | null,
  tasks: Task[],
  onCancel: () => void,
  onDismiss: () => void,
): ReactNode | undefined {
  if (lane.id !== 'ready_to_merge') return undefined;
  const hasConflicts = laneTasks.some((task) => task.conflict);
  if (!mergeRun && !recentRunSummary && !hasConflicts) return undefined;
  return (
    <MergeRunStrip
      active={mergeRun}
      summary={recentRunSummary}
      tasks={tasks}
      onCancel={onCancel}
      onDismiss={onDismiss}
    />
  );
}

// Progress strip rendered above the Ready-to-Merge lane during a backend
// merge run. Dispatches to one of the presentational strip states in
// MergeRunStripStates.tsx by priority:
//   1. active run → spinner with task progress
//   2. pending conflicts (resolver Claude still running) → spinner "resolving"
//   3. completed run summary → dismissable result line
export function MergeRunStrip({
  active,
  summary,
  tasks,
  onCancel,
  onDismiss,
}: {
  active: MergeRun | null;
  summary: MergeRun | null;
  tasks: Task[];
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const pendingConflicts = tasks.filter((t) => t.conflict);
  if (active) return <ActiveStrip run={active} tasks={tasks} onCancel={onCancel} />;
  if (pendingConflicts.length > 0) return <ResolvingStrip conflicts={pendingConflicts} />;
  if (summary) return <SummaryStrip run={summary} tasks={tasks} onDismiss={onDismiss} />;
  return null;
}
