import type { AgentHarness } from '../../harnesses';

export type WorkflowStepHarness = AgentHarness;

// Null/undefined means "Default": use each step's stored harness. A concrete
// value overrides every step for that run or queued entry.
export type WorkflowRunHarnessOverride = WorkflowStepHarness | null;
export type WorkflowRunModelOverride = WorkflowRunHarnessOverride;

// Mirrors backend WorkflowStepKind. 'agent' is a normal AI-agent step;
// 'start' / 'merge' / 'push' are headless control-flow steps the backend
// executes against the task pipeline. 'test' ("Run tests") is an agent step
// with a fixed brief: it runs the project's tests on the main checkout, commits
// fixes, never stops the workflow, and reports into `WorkflowRun.stepSummaries`.
export type WorkflowStepKind = 'agent' | 'start' | 'merge' | 'push' | 'test';

// Run tests step timeout, minutes (mirrors backend workflows/types.ts).
export const RUN_TESTS_DEFAULT_TIMEOUT_MINUTES = 60;
export const RUN_TESTS_MIN_TIMEOUT_MINUTES = 5;
export const RUN_TESTS_MAX_TIMEOUT_MINUTES = 720;

export type WorkflowStep = {
  id: string;
  title: string;
  prompt: string;
  harness: WorkflowStepHarness;
  // Pi model ("provider/model") for this step; used only when harness is `pi`.
  piModel?: string;
  kind?: WorkflowStepKind;
  // Frozen (the step row's snowflake toggle): the step is kept in the workflow
  // but skipped when the workflow runs. Applies to every step kind.
  frozen?: boolean;
  parallel?: boolean;
  // Pre-run tools for an agent step (shown as a read-only shield badge; set by
  // the "Opengrep" quick-add chip / template, never by a per-step toggle): each
  // runs before the harness spawns and its report lands beside
  // WORKFLOW_STEP.md. v1: `opengrep`. Mirrors backend `WorkflowStepTool`.
  tools?: WorkflowStepTool[];
  // Run tests ('test') steps only: minutes the agent may run once its terminal
  // has spawned (absent = 60). The backend clamps it to [5, 720].
  timeoutMinutes?: number;
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

export type WorkflowStepExecution = {
  stepId: string;
  phase: 'pending' | 'spawning' | 'running' | 'completing' | 'completed' | 'skipped' | 'errored' | 'cancelled';
  error?: string;
};

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
  activeStepIndices?: number[];
  stepStates?: Record<number, WorkflowStepExecution>;
  harnessOverride?: WorkflowStepHarness;
  // Pi model override, applied to every step when harnessOverride is `pi`.
  piModelOverride?: string;
  error?: string;
  // Per-step result text keyed by step index — today only Run tests steps
  // write one (TEST_SUMMARY.md + Lattice's notes + the commits post-check).
  stepSummaries?: Record<number, string>;
};

export type WorkflowRunStartOptions = {
  harnessOverride?: WorkflowRunHarnessOverride;
  modelOverride?: WorkflowRunModelOverride;
  // Pi model override for the run, applied when the override harness is `pi`.
  piModelOverride?: string;
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
  // `recovering: true` = sent while the backend is still re-registering
  // persisted runs after a restart: a PARTIAL view, merged additively (a run
  // missing from it is not finished). An authoritative hello follows.
  | { type: 'hello'; runs: WorkflowRun[]; recovering?: boolean }
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
      parallel?: boolean;
      runId: string;
      projectPath: string;
      stepIndex: number;
      kind: WorkflowStepKind;
      current: number;
      total: number;
      message?: string;
    };
