import type { WorkflowRun } from '../../api';

// Per-row execution state, derived from the active (or recently-finished) run's
// `currentStepIndex` and threaded down into each StepRow so the editor doubles
// as a live run view: which step is running, which already ran, which are still
// pending, and where a failure landed.
//
// Pure + side-effect-free so it can be unit-tested in isolation
// (`src/__tests__/stepRunStatus.test.ts`) without pulling in React/StepRow.
export type StepRunStatus = 'running' | 'done' | 'pending' | 'error';

// Map a row index onto the run's progress. Rows before the current step have
// run (done); the current step is running (or, if the run failed/finished on
// it, error/done); rows after are pending. Rows beyond the run's step count
// (the workflow was edited since it started) get no status so they aren't
// mislabeled as part of this run.
//
// Backend semantics this relies on (backend/src/workflowRuns.ts): while running,
// `currentStepIndex` is the executing step; at completion it advances to
// `totalSteps` (so every row is < it → done); on a dispatch failure it points
// at the step that failed to spawn (→ that row is `error`).
export function stepRunStatus(
  index: number,
  run: WorkflowRun | null | undefined,
): StepRunStatus | undefined {
  if (!run) return undefined;
  if (index >= run.totalSteps) return undefined;
  if (index < run.currentStepIndex) return 'done';
  if (index > run.currentStepIndex) return 'pending';
  switch (run.status) {
    case 'running':
      return 'running';
    case 'errored':
      return 'error';
    case 'completed':
      return 'done';
    case 'cancelled':
    default:
      return 'pending';
  }
}
