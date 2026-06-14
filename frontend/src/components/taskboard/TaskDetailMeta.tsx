import type { Task } from '../../api';
import type { Lane } from './lanes';

type TaskDetailMetaProps = {
  task: Task;
  lane: Lane;
};

// Read-only meta-info block (status, timestamps, branch/worktree) shown
// between the description editor and the action row in the detail overlay.
export function TaskDetailMeta({ task, lane }: TaskDetailMetaProps) {
  return (
    <div className="taskboard-detail-meta">
      <span>
        Status:{' '}
        <span style={{ color: lane.color, fontWeight: 600 }}>{lane.label}</span>
      </span>
      <span>Created: {new Date(task.createdAt).toLocaleString()}</span>
      {task.startedAt && (
        <span>Started: {new Date(task.startedAt).toLocaleString()}</span>
      )}
      {task.completedAt && (
        <span>Completed: {new Date(task.completedAt).toLocaleString()}</span>
      )}
      {task.branch && (
        <span>
          Branch: <code>{task.branch}</code>
        </span>
      )}
      {task.worktreePath && (
        <span>
          Worktree: <code>{task.worktreePath}</code>
        </span>
      )}
    </div>
  );
}
