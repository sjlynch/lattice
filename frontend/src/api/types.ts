// Shared types for the Lattice API. Mirrors the backend type surface
// (intentionally hand-maintained — Lattice has no codegen step).

// ---------- Scan / graph ----------

export type GraphNode = {
  id: string;
  name: string;
  path: string;
  kind: 'dir' | 'file';
  ext?: string;
  size?: number;
  health?: number;
  loc?: number;
};

export type GraphLink = {
  source: string;
  target: string;
};

export type ScanResult = {
  root: string;
  nodes: GraphNode[];
  links: GraphLink[];
};

export type DirEntry = { name: string; path: string };
export type DirListing = {
  path: string;
  parent: string | null;
  entries: DirEntry[];
};

// ---------- User settings ----------

export type UserSettings = {
  sidebarWidth?: number;
  harness?: 'claude' | 'pi' | 'interleave';
};

export type HarnessAvailability = {
  claude: boolean;
  pi: boolean;
};

// ---------- Tasks ----------

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
};

export type RunTaskResult = {
  worktreePath: string;
  branch: string;
  taskFile: string;
  command: string;
};

export type MergeTaskResult =
  | { merged: true }
  | {
      merged: false;
      conflict: true;
      command: string;
      cwd: string;
      conflictedFiles?: string[];
    }
  | {
      merged: false;
      stashConflict: true;
      command: string;
      cwd: string;
      conflictedFiles?: string[];
    };

// ---------- Merge runs ----------

export type MergeRunStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'errored';

export type MergeRun = {
  id: string;
  projectPath: string;
  status: MergeRunStatus;
  startedAt: number;
  finishedAt?: number;
  total: number;
  processed: number;
  current?: string;
  merged: string[];
  conflicted: string[];
  errored: { taskId: string; error: string }[];
  cancelRequested: boolean;
};

export type MergeRunEvent =
  | { type: 'started'; run: MergeRun }
  | { type: 'progress'; run: MergeRun }
  | {
      type: 'conflict';
      runId: string;
      projectPath: string;
      taskId: string;
      command: string;
      cwd: string;
      conflictedFiles: string[];
    }
  | { type: 'completed'; run: MergeRun }
  | { type: 'cancelled'; run: MergeRun }
  | { type: 'idle' };

// ---------- Workflows ----------

export type WorkflowStepMode = 'sequential' | 'parallel';

export type WorkflowStep = {
  id: string;
  title: string;
  prompt: string;
  mode: WorkflowStepMode;
};

export type Workflow = {
  id: string;
  name: string;
  projectPath: string;
  steps: WorkflowStep[];
  createdAt: number;
};

export type WorkflowRunStatus = 'running' | 'completed' | 'errored';

export type WorkflowRun = {
  id: string;
  workflowId: string;
  workflowName: string;
  projectPath: string;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt?: number;
  totalSteps: number;
  currentStepIndex: number;
  taskIdsByStep: string[];
  error?: string;
};

export type WorkflowSpawnInfo = {
  taskId: string;
  command: string;
  worktreePath: string;
  stepIndex: number;
};

export type WorkflowRunResult = {
  run: WorkflowRun;
  spawn: WorkflowSpawnInfo;
};

export type WorkflowRunEvent =
  | { type: 'hello'; runs: WorkflowRun[] }
  | { type: 'started'; run: WorkflowRun }
  | { type: 'progress'; run: WorkflowRun }
  | { type: 'completed'; run: WorkflowRun }
  | { type: 'errored'; run: WorkflowRun }
  | {
      type: 'task-spawned';
      runId: string;
      projectPath: string;
      taskId: string;
      command: string;
      worktreePath: string;
      stepIndex: number;
    };
