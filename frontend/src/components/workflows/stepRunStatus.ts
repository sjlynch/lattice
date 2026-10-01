import type { WorkflowRun } from '../../api';

// Per-row execution state, derived from captured member state (or a legacy
// run's `currentStepIndex`) and threaded down into each StepRow so the editor doubles
// as a live run view: which step is running, which already ran, which are still
// pending, and where a failure landed.
//
// Pure + side-effect-free so it can be unit-tested in isolation
// (`src/__tests__/stepRunStatus.test.ts`) without pulling in React/StepRow.
export type StepRunStatus =
  | 'running'
  | 'done'
  | 'pending'
  | 'queued'
  | 'cancelled'
  | 'error'
  | 'skipped';

// New runs map by captured step ID so editor edits cannot move live statuses.
// The index/frozen comparison below is the fallback for legacy serial runs.
// Rows before the current step have
// run (done); the current step is running (or, if the run failed/finished on
// it, error/done); rows after are pending. Rows beyond the run's step count
// (the workflow was edited since it started) get no status so they aren't
// mislabeled as part of this run.
//
// A `frozen` row is `skipped` regardless of where the run's index sits: the
// backend walks straight past frozen steps, so `currentStepIndex` jumps over
// them and the plain index comparison below would otherwise report a skipped
// step as `done`.
//
// Backend semantics this relies on (backend/src/workflowRuns.ts): while running,
// `currentStepIndex` is the executing step; at completion it advances to
// `totalSteps` (so every row is < it → done); on a dispatch failure it points
// at the step that failed to spawn (→ that row is `error`).
export function stepRunStatus(
  index: number,
  run: WorkflowRun | null | undefined,
  frozen = false,
  stepId?: string,
): StepRunStatus | undefined {
  if (!run) return undefined;
  if (run.stepStates) {
    const entry = stepId ? Object.entries(run.stepStates).find(([, s]) => s.stepId === stepId)
      : run.stepStates[index] ? [String(index), run.stepStates[index]] as const : undefined;
    if (!entry) return undefined;
    const [key, state] = entry;
    switch (state.phase) {
      case 'completed': return 'done';
      case 'skipped': return 'skipped';
      case 'errored': return 'error';
      case 'cancelled': return 'cancelled';
      case 'running': case 'completing': return 'running';
      case 'spawning': return 'queued';
      case 'pending': return run.activeStepIndices?.includes(Number(key)) ? 'queued' : 'pending';
    }
  }
  if (index >= run.totalSteps) return undefined;
  if (frozen) return 'skipped';
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
