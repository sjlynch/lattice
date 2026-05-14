import { Fragment, type ReactNode } from 'react';
import type { Task, TaskStatus } from '../../api';
import { LaneHeader } from './LaneHeader';
import { TaskCard } from './TaskCard';
import type { Lane as LaneDef } from './lanes';
import { useLaneDropTargets, type LaneSlotProps } from './hooks/useLaneDropTargets';

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
  onResume,
  onMerge,
  getFocusTerminal,
  onRunAll,
  onPush,
  pushDisabled,
  onView,
  onSingleSelect,
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
  onResume: (task: Task) => void;
  onMerge: (task: Task) => Promise<boolean>;
  getFocusTerminal?: (task: Task) => (() => void) | null;
  onRunAll?: () => void;
  onPush?: () => void;
  pushDisabled?: boolean;
  onView: (task: Task) => void;
  onSingleSelect: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onRangeSelect: (id: string) => void;
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
  const selectedIdsInLane = tasks.filter((t) => selectedIds.has(t.id)).map((t) => t.id);
  const dragging = !!draggingId;

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
        onPush={onPush}
        pushDisabled={pushDisabled}
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
                  laneColor={lane.color}
                  isDragging={
                    draggingId === t.id ||
                    (draggingId !== null &&
                      selectedIds.has(draggingId) &&
                      selectedIds.has(t.id))
                  }
                  isSelected={selectedIds.has(t.id)}
                  selectedIdsInLane={selectedIdsInLane}
                  onDragStart={() => onDragStart(t.id)}
                  onDragEnd={onDragEnd}
                  onDelete={() => onDelete(t.id)}
                  onRun={lane.id === 'open' ? () => onRun(t) : undefined}
                  onResume={
                    lane.id === 'in_progress' && t.worktreePath
                      ? () => onResume(t)
                      : undefined
                  }
                  onMerge={
                    lane.id === 'ready_to_merge'
                      ? () => onMerge(t)
                      : undefined
                  }
                  onFocusTerminal={getFocusTerminal?.(t) ?? undefined}
                  onView={() => onView(t)}
                  onSelect={() => onSingleSelect(t.id)}
                  onToggleSelect={() => onToggleSelect(t.id)}
                  onRangeSelect={() => onRangeSelect(t.id)}
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
