// Shared types for the Lattice API. Mirrors the backend type surface
// (intentionally hand-maintained — Lattice has no codegen step).

// ---------- Scan / graph ----------

export type HealthLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp'
  | 'ruby'
  | 'fallback';

export type HealthSmellId =
  | 'todo_fixme'
  | 'magic_number'
  | 'long_string_literal'
  | 'commented_code'
  | 'empty_catch'
  | 'large_file'
  | 'long_function'
  | 'high_complexity'
  | 'high_cognitive_complexity'
  | 'deep_nesting'
  | 'long_param_list'
  | 'multiple_classes'
  | 'high_function_count'
  | 'low_maintainability'
  | 'god_function'
  | 'console_log'
  | 'debugger_stmt'
  | 'any_type'
  | 'type_assertion'
  | 'ts_ignore'
  | 'eslint_disable'
  | 'non_null_assertion'
  | 'var_keyword'
  | 'loose_equality'
  | 'eval_call'
  | 'mixed_exports'
  | 'deep_optional_chain'
  | 'deep_ternary'
  | 'mixed_sync_async'
  | 'boolean_param'
  | 'magic_string'
  | 'empty_interface'
  | 'print_call'
  | 'bare_except'
  | 'wildcard_import'
  | 'mutable_default_arg'
  | 'global_keyword'
  | 'missing_docstring'
  | 'circular_dependency'
  | 'high_fan_out'
  | 'high_fan_in';

export type HealthSmell = {
  id: HealthSmellId;
  count: number;
  label: string;
};

export type HalsteadMetrics = {
  vocabulary: number;
  length: number;
  volume: number;
  difficulty: number;
  effort: number;
};

export type HealthMetrics = {
  score: number;
  language: HealthLanguage;
  loc: number;
  commentRatio: number;
  cyclomaticMax: number;
  cyclomaticTotal: number;
  cognitiveMax: number;
  cognitiveTotal: number;
  maxNestingDepth: number;
  halstead: HalsteadMetrics;
  maintainabilityIndex: number;
  functionCount: number;
  namedFunctionCount: number;
  avgFunctionLength: number;
  maxFunctionLength: number;
  maxParamCount: number;
  classCount: number;
  callGraphDensity: number;
  godFunctionRatio: number;
  fanIn?: number;
  fanOut?: number;
  inCycle?: boolean;
  smells: HealthSmell[];
  smellCount: number;
};

export type HealthUpdate =
  | { type: 'updated'; filePath: string; metrics: HealthMetrics }
  | { type: 'removed'; filePath: string };

export type GraphNode = {
  id: string;
  name: string;
  path: string;
  kind: 'dir' | 'file';
  ext?: string;
  size?: number;
  health?: number;
  healthDetails?: HealthMetrics;
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

// ---------- Git history (timeline scrubber) ----------

export type GitFileStatus = 'A' | 'M' | 'D' | 'R';

export type GitCommitChange = {
  path: string;
  status: GitFileStatus;
  oldPath?: string;
};

export type GitCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  date: number;
  changes: GitCommitChange[];
};

export type GitUncommitted = {
  changes: GitCommitChange[];
};

export type GitHistoryResult = {
  isRepo: boolean;
  commits: GitCommit[];
  uncommitted: GitUncommitted;
};

// ---------- User settings ----------

export type StartupTerminal = {
  id: string;
  label: string;
  command: string;
};

export type UserSettings = {
  sidebarWidth?: number;
  harness?: 'claude' | 'pi' | 'codex' | 'interleave';
  startupTerminals?: StartupTerminal[];
};

export type HarnessAvailability = {
  claude: boolean;
  pi: boolean;
  codex: boolean;
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
  // Set when the backend pre-spawned the pty in the terminal-server. The
  // frontend stores it on the TerminalSpec so the pane can lazy-mount and
  // attach via this id (replay path) instead of triggering a new session.
  serverId?: string;
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
      serverId?: string;
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

export type WorkflowRunStatus = 'running' | 'completed' | 'errored' | 'cancelled';

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
  error?: string;
};

export type WorkflowRunResult = {
  run: WorkflowRun;
};

export type WorkflowRunEvent =
  | { type: 'hello'; runs: WorkflowRun[] }
  | { type: 'started'; run: WorkflowRun }
  | { type: 'progress'; run: WorkflowRun }
  | { type: 'completed'; run: WorkflowRun }
  | { type: 'errored'; run: WorkflowRun }
  | { type: 'cancelled'; run: WorkflowRun }
  | {
      type: 'step-spawned';
      runId: string;
      projectPath: string;
      stepIndex: number;
      command: string;
      cwd: string;
      serverId?: string;
    };
