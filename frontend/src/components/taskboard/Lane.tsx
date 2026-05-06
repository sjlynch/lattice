import { Fragment, useState, type ReactNode } from 'react';
import { CheckCheck, GitMerge, Play, Plus } from 'lucide-react';
import type { Task, TaskStatus } from '../../api';
import { DRAG_MIME, parseDragPayload, type Lane as LaneDef } from './lanes';
import { TaskCard } from './TaskCard';

// One lane in the kanban. Hosts drop targets for cross-lane drops and
// per-position drop slots between cards. Lane background drops do a
// status-only move (preserving the prior "drop anywhere" behavior); slot
// drops set both status and position.
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
  onView: (task: Task) => void;
  onSingleSelect: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onRangeSelect: (id: string) => void;
  onClearSelection: () => void;
  strip?: ReactNode;
}) {
  const [isOver, setIsOver] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // IDs of selected tasks in this lane (preserves lane order for multi-drag).
  const selectedIdsInLane = tasks.filter(t => selectedIds.has(t.id)).map(t => t.id);

  function onDragOver(e: React.DragEvent) {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!isOver) setIsOver(true);
  }
  function onDragLeave(e: React.DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsOver(false);
    setHoverIndex(null);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
    const ids = parseDragPayload(raw);
    if (ids.length > 1) {
      if (hoverIndex !== null) onMultiDropAt(ids, lane.id, hoverIndex);
      else onMultiMove(ids, lane.id);
    } else if (ids.length === 1) {
      if (hoverIndex !== null) onDropAt(ids[0], lane.id, hoverIndex);
      else onMove(ids[0], lane.id);
    }
    setIsOver(false);
    setHoverIndex(null);
  }

  function slotProps(idx: number) {
    return {
      onDragEnter: (e: React.DragEvent) => {
        if (!draggingId) return;
        e.preventDefault();
        e.stopPropagation();
        setHoverIndex(idx);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!draggingId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (hoverIndex !== idx) setHoverIndex(idx);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
        const ids = parseDragPayload(raw);
        if (ids.length > 1) {
          onMultiDropAt(ids, lane.id, idx);
        } else if (ids.length === 1) {
          onDropAt(ids[0], lane.id, idx);
        }
        setIsOver(false);
        setHoverIndex(null);
      },
    };
  }

  const dragging = !!draggingId;

  const runAllConfig = onRunAll
    ? laneRunAllConfig(lane.id, tasks)
    : null;

  return (
    <div
      className={`taskboard-lane ${isOver ? 'drop-target' : ''} ${
        dragging ? 'dragging-active' : ''
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="taskboard-lane-head">
        <span className="taskboard-lane-title">
          <span
            className="taskboard-lane-dot"
            style={{ background: lane.color }}
          />
          {lane.label}
          <span className="taskboard-lane-count">{tasks.length}</span>
          {onRunAll && runAllConfig && (
            <button
              className={`lane-runall ${runAllConfig.cls}`}
              onClick={onRunAll}
              disabled={runAllConfig.disabled}
              title={runAllConfig.title}
              aria-label={runAllConfig.aria}
            >
              {runAllConfig.icon}
            </button>
          )}
        </span>
        <div className="taskboard-lane-actions">
          <button
            className="icon-btn sm"
            onClick={onAdd}
            title="Add task"
            aria-label="Add task"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
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
            <div
              className={`taskboard-dropslot ${
                hoverIndex === 0 ? 'active' : ''
              }`}
              style={{ ['--lane-color' as string]: lane.color }}
              {...slotProps(0)}
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
                <div
                  className={`taskboard-dropslot ${
                    hoverIndex === i + 1 ? 'active' : ''
                  }`}
                  style={{ ['--lane-color' as string]: lane.color }}
                  {...slotProps(i + 1)}
                />
              </Fragment>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// Lane-specific bulk-action presentation. Centralized here so the JSX
// above stays focused on layout rather than per-lane copy.
function laneRunAllConfig(id: TaskStatus, tasks: Task[]) {
  switch (id) {
    case 'ready_to_merge':
      return {
        cls: 'merge',
        disabled: tasks.length === 0,
        title: 'Merge every Ready-to-Merge task (stops on first conflict)',
        aria: 'Merge all ready tasks',
        icon: <GitMerge size={11} />,
      };
    case 'in_progress':
      return {
        cls: 'resume',
        disabled: tasks.filter((t) => !!t.worktreePath).length === 0,
        title: 'Resume every In Progress task with an existing worktree',
        aria: 'Resume all in-progress tasks',
        icon: <Play size={11} fill="currentColor" />,
      };
    case 'qa':
      return {
        cls: 'qa-done',
        disabled: tasks.length === 0,
        title: 'Mark every QA task as Done',
        aria: 'Mark all QA tasks done',
        icon: <CheckCheck size={12} />,
      };
    case 'open':
      return {
        cls: '',
        disabled: tasks.length === 0,
        title: 'Run every task in Open in a new worktree',
        aria: 'Run all open tasks',
        icon: <Play size={11} fill="currentColor" />,
      };
    default:
      return null;
  }
}
