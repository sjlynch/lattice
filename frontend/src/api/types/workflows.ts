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
  // Pi model ("provider/model") for this step; used only when harness is `pi`.
  piModel?: string;
  kind?: WorkflowStepKind;
  // Frozen (the step row's snowflake toggle): the step is kept in the workflow
  // but skipped when the workflow runs. Applies to every step kind.
  frozen?: boolean;
  // Pre-run tools for an agent step (shown as a read-only shield badge; set by
  // the "Opengrep" quick-add chip / template, never by a per-step toggle): each
  // runs before the harness spawns and its report lands beside
  // WORKFLOW_STEP.md. v1: `opengrep`. Mirrors backend `WorkflowStepTool`.
  tools?: WorkflowStepTool[];
};

export type WorkflowStepTool = 'opengrep';

// A user-defined variable injected into step prompts via `{{name}}`. Every
// workflow always carries the built-in `user_instructions` variable.
export type WorkflowVariable = {
  id: string;
  name: string;
  value: string;
};

export type Workflow = {
  id: string;
  name: string;
  projectPath: string;
  steps: WorkflowStep[];
  variables: WorkflowVariable[];
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
  // Pi model override, applied to every step when harnessOverride is `pi`.
  piModelOverride?: string;
  error?: string;
};

export type WorkflowRunStartOptions = {
  harnessOverride?: WorkflowRunHarnessOverride;
  modelOverride?: WorkflowRunModelOverride;
  // Pi model override for the run, applied when the override harness is `pi`.
  piModelOverride?: string;
  // Sequential-queue dispatch: ask the backend to 409 if a run is already
  // active for the project (the queue then requeues + retries when the slot
  // frees). Manual ▶ Run and parallel-queue starts leave it unset.
  requireNoActiveRun?: boolean;
};

export type WorkflowRunResult = {
  run: WorkflowRun;
};

export type WorkflowQueueEntry = {
  id: string;
  workflowId: string;
  harnessOverride: WorkflowRunHarnessOverride;
  // Pi model override carried alongside harnessOverride when it's `pi`.
  piModelOverride?: string;
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
  terminalId?: string;
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
      terminalId?: string;
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
      terminalId?: string;
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
