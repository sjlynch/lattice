// Deep-enough copy of a run for persistence and event payloads: every nested
// container a later mutation could touch is cloned, so a snapshot never
// changes after it is taken. A leaf (pure, no store imports) so that
// persistence.ts and state.ts can both use it without importing each other.
import { cloneWorkflowDefinition } from './definition.js';
import type { WorkflowRun } from './types.js';

export function snapshot(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    ...(run.activeStepIndices ? { activeStepIndices: [...run.activeStepIndices] } : {}),
    ...(run.notes ? { notes: [...run.notes] } : {}),
    ...(run.roundTaskIds ? { roundTaskIds: [...run.roundTaskIds] } : {}),
    ...(run.stepStates ? { stepStates: Object.fromEntries(Object.entries(run.stepStates).map(([index, step]) =>
      [index, { ...step, ...(step.stopReceived ? { stopReceived: { ...step.stopReceived } } : {}) }])) } : {}),
    ...(run.definition ? { definition: cloneWorkflowDefinition(run.definition) } : {}),
    ...(run.stepSummaries ? { stepSummaries: { ...run.stepSummaries } } : {}),
    ...(run.testStep ? { testStep: { ...run.testStep } } : {}),
    ...(run.stopReceived ? { stopReceived: { ...run.stopReceived } } : {}),
  };
}
