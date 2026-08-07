// Frozen-step policy for the run engine.
//
// The editor's snowflake toggle sets `WorkflowStep.frozen`. A frozen step keeps
// its place, title and prompt in the workflow definition, but a run walks
// straight past it — no scratch dir, no pty, no control-step worker. That makes
// "temporarily take this step out of the rotation" a one-click operation
// instead of delete-and-retype-the-prompt.
//
// Pure + side-effect-free so the two places that need it (run start and step
// advance in ../workflowRuns.ts) can't drift, and so it is unit-testable
// without the run registry (`__tests__/workflowFrozenSteps.test.ts`).

import type { WorkflowStep } from '../workflows.js';

export function isStepFrozen(step: WorkflowStep | undefined): boolean {
  return step?.frozen === true;
}

// Index of the first runnable (non-frozen) step at or after `from`, or `null`
// when nothing runnable remains — which the caller treats as "the run is
// finished", whether that's because it fell off the end or because every
// remaining step is frozen.
export function nextRunnableStepIndex(
  steps: WorkflowStep[],
  from: number,
): number | null {
  for (let i = Math.max(0, from); i < steps.length; i++) {
    if (!isStepFrozen(steps[i])) return i;
  }
  return null;
}
