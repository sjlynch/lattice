export type WorkflowStepMode = 'sequential' | 'parallel';
export type WorkflowStepHarness = 'claude' | 'pi' | 'codex';

// Null/undefined means "Default": use each step's stored harness. A concrete
// value overrides every step for that run or queued entry.
export type WorkflowRunHarnessOverride = WorkflowStepHarness | null;
export type WorkflowRunModelOverride = WorkflowRunHarnessOverride;

export type WorkflowStep = {
  id: string;
  title: string;
  prompt: string;
  mode: WorkflowStepMode;
  harness: WorkflowStepHarness;
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
  harnessOverride?: WorkflowStepHarness;
  error?: string;
};

export type WorkflowRunStartOptions = {
  harnessOverride?: WorkflowRunHarnessOverride;
  modelOverride?: WorkflowRunModelOverride;
};

export type WorkflowRunResult = {
  run: WorkflowRun;
};

export type WorkflowQueueEntry = {
  id: string;
  workflowId: string;
  harnessOverride: WorkflowRunHarnessOverride;
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
