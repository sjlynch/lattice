export type TaskStatus =
  | 'backlog'
  | 'open'
  | 'in_progress'
  | 'ready_to_merge'
  | 'qa'
  | 'done'
  | 'deleted';

export type Task = {
  id: string;
  projectPath: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: number;
  // Timestamp of the most recent mutation (any field). Set by updateTask /
  // updateTaskCrashSafe; not set by createTask (use createdAt for that).
  updatedAt?: number;
  worktreePath?: string;
  branch?: string;
  startedAt?: number;
  completedAt?: number;
  mergedAt?: number;
  doneAt?: number;
  conflict?: boolean;
  // When the conflict was first detected. Drives the "stuck for X min"
  // indicator on conflict cards so the user can spot a hung resolver.
  conflictStartedAt?: number;
  // Manual ordering within a lane. Lower values sort first. Tasks without a
  // value fall back to `-createdAt` so newly-created tasks land on top, which
  // matches the pre-reorder behavior.
  sortOrder?: number;
  // When this task was spawned by a Workflow run, these record the run it
  // belongs to and which step in that run produced it. The workflow advancer
  // watches for tagged tasks transitioning to `qa` and creates the next step.
  workflowRunId?: string;
  workflowStepIndex?: number;
};

export type TaskUpdates = Partial<
  Omit<Task, 'id' | 'projectPath' | 'createdAt'>
>;

export type TaskSubscriber = (projectPath: string, tasks: Task[]) => void;
