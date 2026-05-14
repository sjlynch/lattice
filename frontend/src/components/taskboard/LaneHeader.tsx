import { CheckCheck, GitMerge, Play, Plus, UploadCloud } from 'lucide-react';
import type { Task, TaskStatus } from '../../api';
import type { Lane as LaneDef } from './lanes';

type Props = {
  lane: LaneDef;
  tasks: Task[];
  onAdd: () => void;
  onRunAll?: () => void;
  // Lane-level "push to remote" action. The launcher passes this only on the
  // QA lane today; rendered as a small icon button next to the add (+) one.
  onPush?: () => void;
  pushDisabled?: boolean;
};

// Lane header row: dot/title/count, lane-level run-all action, push, add.
// Extracted from Lane so the lane body stays focused on drop targets and
// card rendering.
export function LaneHeader({ lane, tasks, onAdd, onRunAll, onPush, pushDisabled }: Props) {
  const runAllConfig = onRunAll ? laneRunAllConfig(lane.id, tasks) : null;

  return (
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
        {onPush && (
          <button
            className="icon-btn sm"
            onClick={onPush}
            disabled={pushDisabled}
            title={pushDisabled ? 'Push in progress…' : 'Push project to remote'}
            aria-label="Push project to remote"
          >
            <UploadCloud size={14} />
          </button>
        )}
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
