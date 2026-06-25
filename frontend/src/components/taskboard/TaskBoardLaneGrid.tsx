import type { MergeRun, Task, TaskStatus } from '../../api';
import { LANES } from './lanes';
import { Lane } from './Lane';
import { bulkRunStripFor } from './BulkRunStrip';
import { mergeRunStripFor } from './MergeRunStrip';
import type { GroupedTasks } from './hooks/useTaskBoardState';
import type { LaneSortMode } from './laneSort';
import type { QaPlaywrightControls } from './hooks/useQaPlaywright';
import type { BulkStripLane, BulkStripView } from './hooks/useBulkRunStrips';

// Renders the visible kanban lanes and owns every per-lane action decision the
// launcher used to make inline: run-all gating under search, the QA-only Push /
// Playwright e2e buttons, per-lane sort wiring, and the merge-vs-bulk strip
// precedence. The launcher passes the resolved hook outputs; the per-lane
// branching all lives here so the launcher's render stays a flat wiring shell.
type Props = {
  visibleLanes: Set<TaskStatus>;
  // Per-lane tasks, already filtered + sorted for display.
  sortedGrouped: GroupedTasks;
  // Live (search-filtered) QA lane, the target of "run all e2e tests".
  qaTasks: Task[];
  // Full task list — the merge-run strip reports across all tasks, not one lane.
  tasks: Task[];

  draggingId: string | null;
  selectedIds: Set<string>;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onToggleSelect: (id: string, laneId: TaskStatus) => void;
  onRangeSelect: (id: string, laneId: TaskStatus) => void;
  onClearSelection: () => void;

  onAdd: (lane: TaskStatus) => void;
  onMove: (id: string, status: TaskStatus) => void;
  onDropAt: (id: string, status: TaskStatus, index: number) => void;
  onMultiMove: (ids: string[], status: TaskStatus) => void;
  onMultiDropAt: (ids: string[], status: TaskStatus, index: number) => void;
  onDelete: (id: string) => void;
  onRun: (task: Task) => void;
  onCancelQueuedRun: (task: Task) => void;
  onResume: (task: Task) => void;
  onMerge: (task: Task) => Promise<boolean>;
  onView: (task: Task) => void;
  getFocusTerminal?: (task: Task) => (() => void) | null;

  getLaneSortMode: (lane: TaskStatus) => LaneSortMode;
  onToggleSort: (lane: TaskStatus) => void;

  // Per-lane "run all" actions; suppressed entirely while a search filter is on
  // so a bulk action can't fire against a partial view.
  searchActive: boolean;
  runAllActionByLane: Partial<Record<TaskStatus, () => void>>;

  // QA-lane Push button.
  hasGit: boolean;
  onPush: () => void;
  pushDisabled: boolean;

  // QA-lane Playwright e2e buttons (per-task + run-all).
  qaPlaywright: QaPlaywrightControls;
  onQaRun: (task: Task) => void;
  onQaRunAll: (tasks: Task[]) => void;

  // Ready-to-Merge backend-run strip and Open/In Progress/QA bulk strips. The
  // merge strip wins where both could apply (`?? `).
  mergeRun: MergeRun | null;
  recentRunSummary: MergeRun | null;
  onCancelActiveRun: () => void;
  onClearStuckConflicts: () => void;
  onDismissRecent: () => void;
  bulkStrips: Partial<Record<BulkStripLane, BulkStripView>>;
  onDismissBulk: (lane: BulkStripLane) => void;
};

export function TaskBoardLaneGrid({
  visibleLanes,
  sortedGrouped,
  qaTasks,
  tasks,
  draggingId,
  selectedIds,
  onDragStart,
  onDragEnd,
  onToggleSelect,
  onRangeSelect,
  onClearSelection,
  onAdd,
  onMove,
  onDropAt,
  onMultiMove,
  onMultiDropAt,
  onDelete,
  onRun,
  onCancelQueuedRun,
  onResume,
  onMerge,
  onView,
  getFocusTerminal,
  getLaneSortMode,
  onToggleSort,
  searchActive,
  runAllActionByLane,
  hasGit,
  onPush,
  pushDisabled,
  qaPlaywright,
  onQaRun,
  onQaRunAll,
  mergeRun,
  recentRunSummary,
  onCancelActiveRun,
  onClearStuckConflicts,
  onDismissRecent,
  bulkStrips,
  onDismissBulk,
}: Props) {
  return (
    <>
      {LANES.filter((lane) => visibleLanes.has(lane.id)).map((lane) => (
        <Lane
          key={lane.id}
          lane={lane}
          tasks={sortedGrouped[lane.id]}
          draggingId={draggingId}
          selectedIds={selectedIds}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onAdd={() => onAdd(lane.id)}
          onMove={onMove}
          onDropAt={onDropAt}
          onMultiMove={onMultiMove}
          onMultiDropAt={onMultiDropAt}
          onDelete={onDelete}
          sortMode={getLaneSortMode(lane.id)}
          onToggleSort={() => onToggleSort(lane.id)}
          onRun={onRun}
          onCancelQueuedRun={onCancelQueuedRun}
          onResume={onResume}
          onMerge={onMerge}
          getFocusTerminal={getFocusTerminal}
          onToggleSelect={onToggleSelect}
          onRangeSelect={onRangeSelect}
          onClearSelection={onClearSelection}
          onRunAll={searchActive ? undefined : runAllActionByLane[lane.id]}
          onPush={lane.id === 'qa' && hasGit ? onPush : undefined}
          pushDisabled={pushDisabled}
          qaPlaywright={lane.id === 'qa' ? qaPlaywright : undefined}
          onQaRun={
            lane.id === 'qa' && qaPlaywright.enabled ? onQaRun : undefined
          }
          onQaRunAll={
            lane.id === 'qa' && qaPlaywright.enabled && !searchActive
              ? () => onQaRunAll(qaTasks)
              : undefined
          }
          onView={onView}
          strip={
            mergeRunStripFor(
              lane,
              sortedGrouped[lane.id],
              mergeRun,
              recentRunSummary,
              tasks,
              onCancelActiveRun,
              onDismissRecent,
              onClearStuckConflicts,
            ) ?? bulkRunStripFor(lane, bulkStrips, onDismissBulk)
          }
        />
      ))}
    </>
  );
}
