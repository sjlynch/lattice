import { type Task } from '../../api';

type Props = {
  tasks: Task[];
  filteredTasks: Task[];
  searchActive: boolean;
};

// Footer summary line: total/matching count, optional running-vs-queued
// spawn-queue indicator, and the static interaction hints.
export function TaskBoardFooter({ tasks, filteredTasks, searchActive }: Props) {
  // Spawn-queue activity: how many agents are running vs. waiting for a slot.
  const runningCount = tasks.filter((t) => t.status === 'in_progress').length;
  const queuedCount = tasks.filter((t) => t.runQueued).length;

  return (
    <div className="taskboard-footer">
      {searchActive
        ? `${filteredTasks.length} of ${tasks.length} matching`
        : `${tasks.length} total`}
      {queuedCount > 0 && (
        <span className="taskboard-footer-queue">
          {' · '}
          {runningCount} running · {queuedCount} queued
        </span>
      )}{' '}
      · drag to reorder · click to select · ctrl+click or shift+click to
      multi-select · pencil to edit
    </div>
  );
}
