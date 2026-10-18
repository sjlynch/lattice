// Workflow definitions and runs. The records and the run event union are the
// backend's own types (backend/src/workflows/types.ts, workflowRuns/types.ts —
// re-exported through backend/src/shared/wireTypes.ts). Declared here: the WS
// `hello` envelope and frontend-only queue/run-start shapes.
import type {
  WorkflowRun,
  WorkflowRunEvent as BackendWorkflowRunEvent,
  WorkflowRunHarnessOverride,
} from '../../../../backend/src/shared/wireTypes';

export type {
  SourceArea,
  SourceAreasResult,
  Workflow,
  WorkflowRun,
  WorkflowRunHarnessOverride,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepExecution,
  WorkflowStepHarness,
  WorkflowStepKind,
  WorkflowStepTool,
  WorkflowVariable,
} from '../../../../backend/src/shared/wireTypes';

// Null/undefined means "Default": use each step's stored harness. A concrete
// value overrides every step for that run or queued entry.
export type WorkflowRunModelOverride = WorkflowRunHarnessOverride;

// Run tests step timeout, minutes. Runtime values, so they can't ride the
// type-only wireTypes.ts: keep equal to backend workflows/types.ts.
export const RUN_TESTS_DEFAULT_TIMEOUT_MINUTES = 60;
export const RUN_TESTS_MIN_TIMEOUT_MINUTES = 5;
export const RUN_TESTS_MAX_TIMEOUT_MINUTES = 720;

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

export type WorkflowRunEvent =
  // Sent by `/ws/workflow-runs` on connect (ws/endpoints/workflowRuns.ts).
  // `recovering: true` = sent while the backend is still re-registering
  // persisted runs after a restart: a PARTIAL view, merged additively (a run
  // missing from it is not finished). An authoritative hello follows.
  | { type: 'hello'; runs: WorkflowRun[]; recovering?: boolean }
  | BackendWorkflowRunEvent;
