import type { AgentHarness } from '../../harnesses';

export type WorkflowStepMode = 'sequential' | 'parallel';
export type WorkflowStepHarness = AgentHarness;

// Null/undefined means "Default": use each step's stored harness. A concrete
// value overrides every step for that run or queued entry.
export type WorkflowRunHarnessOverride = WorkflowStepHarness | null;
export type WorkflowRunModelOverride = WorkflowRunHarnessOverride;

// Mirrors backend WorkflowStepKind. 'agent' is a normal AI-agent step;
// 'start' / 'merge' / 'push' are headless control-flow steps the backend
// executes against the task pipeline.
export type WorkflowStepKind = 'agent' | 'start' | 'merge' | 'push';

export type WorkflowStep = {
  id: string;
  title: string;
  prompt: string;
  mode: WorkflowStepMode;
  harness: WorkflowStepHarness;
  kind?: WorkflowStepKind;
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

export type WorkflowPromptTemplateId =
  | 'refactor'
  | 'bug-catcher'
  | 'combine-tasks'
  | 'pmf'
  | 'brainstorm';

export type WorkflowPromptCustomizationStatus =
  | 'running'
  | 'completed'
  | 'errored';

export type WorkflowPromptCustomization = {
  id: string;
  projectPath: string;
  stepTitle: string;
  originalPrompt: string;
  templateId?: WorkflowPromptTemplateId;
  templateTitle?: string;
  customInstructions?: string;
  harness: WorkflowStepHarness;
  status: WorkflowPromptCustomizationStatus;
  createdAt: number;
  finishedAt?: number;
  resultPrompt?: string;
  error?: string;
  command: string;
  cwd: string;
  serverId?: string;
};

export type StartWorkflowPromptCustomizationInput = {
  project: string;
  stepTitle: string;
  prompt: string;
  templateId?: WorkflowPromptTemplateId;
  templateTitle?: string;
  customInstructions?: string;
  harness: WorkflowStepHarness;
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
    }
  | {
      type: 'workflow-task-spawned';
      runId: string;
      projectPath: string;
      stepIndex: number;
      taskId: string;
      title: string;
      command: string;
      cwd: string;
      serverId?: string;
    }
  | {
      type: 'step-control-progress';
      runId: string;
      projectPath: string;
      stepIndex: number;
      kind: WorkflowStepKind;
      current: number;
      total: number;
      message?: string;
    };
