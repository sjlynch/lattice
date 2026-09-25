import { Fragment, useCallback, useMemo, type ReactNode } from 'react';
import type { Task, TaskStatus } from '../../api';
import { LaneHeader } from './LaneHeader';
import { TaskCard } from './TaskCard';
import type { Lane as LaneDef } from './lanes';
import type { LaneSortMode } from './laneSort';
import { useLaneDropTargets, type LaneSlotProps } from './hooks/useLaneDropTargets';
import type { QaPlaywrightControls } from './hooks/useQaPlaywright';

// One lane in the kanban. Hosts drop targets for cross-lane drops and
// per-position drop slots between cards. Lane background drops do a
// status-only move (preserving the prior "drop anywhere" behavior); slot
// drops set both status and position. Drag/drop mechanics live in
// useLaneDropTargets; header chrome lives in LaneHeader.
export function Lane({
  lane,
  tasks,
  draggingId,
  selectedIds,
  onDragStart,
  onDragEnd,
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
  onQaRun,
  runningQaTaskIds,
  getFocusTerminal,
  onRunAll,
  onQaRunAll,
  onPush,
  pushDisabled,
  qaPlaywright,
  sortMode,
  onToggleSort,
  onView,
  onToggleSelect,
  onRangeSelect,
  onClearSelection,
  strip,
}: {
  lane: LaneDef;
  tasks: Task[];
  draggingId: string | null;
  selectedIds: Set<string>;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onAdd: () => void;
  onMove: (id: string, status: TaskStatus) => void;
  onDropAt: (id: string, status: TaskStatus, index: number) => void;
  onMultiMove: (ids: string[], status: TaskStatus) => void;
  onMultiDropAt: (ids: string[], status: TaskStatus, index: number) => void;
  onDelete: (id: string) => void;
  onRun: (task: Task) => void;
  onCancelQueuedRun: (task: Task) => void;
  onResume: (task: Task) => void;
  onMerge: (task: Task) => Promise<boolean>;
  // QA-lane per-task "run e2e test"; passed only when the Playwright MCP is on.
  onQaRun?: (task: Task) => void;
  // QA tasks whose e2e session is already running.
  runningQaTaskIds?: ReadonlySet<string>;
  getFocusTerminal?: (task: Task) => (() => void) | null;
  onRunAll?: () => void;
  // QA-lane "run all e2e tests"; passed only when the Playwright MCP is on.
  onQaRunAll?: () => void;
  onPush?: () => void;
  pushDisabled?: boolean;
  qaPlaywright?: QaPlaywrightControls;
  // Per-lane arrival-date sort state + toggle (clock + up/down caret header).
  sortMode: LaneSortMode;
  onToggleSort: () => void;
  onView: (task: Task) => void;
  onToggleSelect: (id: string, laneId: TaskStatus) => void;
  onRangeSelect: (id: string, laneId: TaskStatus) => void;
  onClearSelection: () => void;
  strip?: ReactNode;
}) {
  const { isOver, hoverIndex, onDragOver, onDragLeave, onDrop, slotProps } =
    useLaneDropTargets(lane.id, draggingId, {
      onMove,
      onDropAt,
      onMultiMove,
      onMultiDropAt,
    });

  // IDs of selected tasks in this lane (preserves lane order for multi-drag).
  // Memoized so cards receive a referentially stable array — with the sibling
  // structural-sharing change to the task list, this only changes when the
  // lane's tasks or the selection actually change, not on every WS tick.
  const selectedIdsInLane = useMemo(
    () => tasks.filter((t) => selectedIds.has(t.id)).map((t) => t.id),
    [tasks, selectedIds],
  );
  const dragging = !!draggingId;

  // Bind the lane id into the selection handlers once per lane (not per card),
  // keeping the per-card props stable so React.memo(TaskCard) can do its job.
  const handleToggleSelect = useCallback(
    (id: string) => onToggleSelect(id, lane.id),
    [onToggleSelect, lane.id],
  );
  const handleRangeSelect = useCallback(
    (id: string) => onRangeSelect(id, lane.id),
    [onRangeSelect, lane.id],
  );

  return (
    <div
      className={`taskboard-lane ${isOver ? 'drop-target' : ''} ${
        dragging ? 'dragging-active' : ''
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <LaneHeader
        lane={lane}
        tasks={tasks}
        onAdd={onAdd}
        onRunAll={onRunAll}
        onQaRunAll={onQaRunAll}
        onPush={onPush}
        pushDisabled={pushDisabled}
        qaPlaywright={qaPlaywright}
        sortMode={sortMode}
        onToggleSort={onToggleSort}
      />
      {strip}
      <div
        className="taskboard-lane-track"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClearSelection();
        }}
      >
        {tasks.length === 0 ? (
          <div
            className={`taskboard-lane-empty ${
              dragging && hoverIndex === 0 ? 'slot-active' : ''
            }`}
            {...slotProps(0)}
          >
            {isOver ? 'Drop here' : 'No tasks'}
          </div>
        ) : (
          <>
            <DropSlot
              active={hoverIndex === 0}
              laneColor={lane.color}
              slotProps={slotProps(0)}
            />
            {tasks.map((t, i) => (
              <Fragment key={t.id}>
                <TaskCard
                  task={t}
                  laneId={lane.id}
                  laneColor={lane.color}
                  isDragging={
                    draggingId === t.id ||
                    (draggingId !== null &&
                      selectedIds.has(draggingId) &&
                      selectedIds.has(t.id))
                  }
                  isSelected={selectedIds.has(t.id)}
                  selectedIdsInLane={selectedIdsInLane}
                  getFocusTerminal={getFocusTerminal}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onDelete={onDelete}
                  onRun={onRun}
                  onCancelQueuedRun={onCancelQueuedRun}
                  onResume={onResume}
                  onMerge={onMerge}
                  onQaRun={onQaRun}
                  qaRunning={runningQaTaskIds?.has(t.id) ?? false}
                  onView={onView}
                  onToggleSelect={handleToggleSelect}
                  onRangeSelect={handleRangeSelect}
                />
                <DropSlot
                  active={hoverIndex === i + 1}
                  laneColor={lane.color}
                  slotProps={slotProps(i + 1)}
                />
              </Fragment>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// Single between-card drop target. Visually a thin strip whose `--lane-color`
// CSS var paints the active state in the lane's accent color.
function DropSlot({
  active,
  laneColor,
  slotProps,
}: {
  active: boolean;
  laneColor: string;
  slotProps: LaneSlotProps;
}) {
  return (
    <div
      className={`taskboard-dropslot ${active ? 'active' : ''}`}
      style={{ ['--lane-color' as string]: laneColor }}
      {...slotProps}
    />
  );
}
