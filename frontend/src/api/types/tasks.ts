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
  updatedAt?: number;
  worktreePath?: string;
  branch?: string;
  startedAt?: number;
  completedAt?: number;
  mergedAt?: number;
  doneAt?: number;
  conflict?: boolean;
  conflictStartedAt?: number;
  sortOrder?: number;
  workflowRunId?: string;
  workflowStepIndex?: number;
  // True while an Open task's run is waiting in the backend spawn queue
  // (concurrency softCap was full when it was requested). Status stays
  // `open`; the card renders a "queued" badge. Cleared when the run is
  // admitted and the task flips to in_progress.
  runQueued?: boolean;
  runQueuedAt?: number;
};

// `/api/tasks/:id/run` and `/resume` no longer return the pty synchronously
// — the run may be deferred by the spawn queue. They acknowledge acceptance;
// the terminal arrives later via the `task-spawned` WS event.
export type RunTaskResult = {
  accepted: boolean;
  // true ⇒ deferred (no concurrency headroom); false ⇒ spawning now.
  queued: boolean;
};

// Pushed on `/ws/tasks` when a queued task's pty spawns. The frontend
// lazy-mounts the task's terminal from it (mirrors workflow `step-spawned`).
export type TaskSpawnedEvent = {
  taskId: string;
  title: string;
  command: string;
  worktreePath: string;
  serverId: string;
  projectPath: string;
};

export type MergeTaskResult =
  | { merged: true }
  | {
      merged: false;
      conflict: true;
      command: string;
      cwd: string;
      conflictedFiles?: string[];
      serverId?: string;
    }
  | {
      merged: false;
      stashConflict: true;
      command: string;
      cwd: string;
      conflictedFiles?: string[];
      serverId?: string;
    };
