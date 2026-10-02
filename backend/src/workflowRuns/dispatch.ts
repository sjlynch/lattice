// Kind-dispatch for workflow steps and groups — re-exported by the facade
// (../workflowRuns.ts). The completion callback (the facade's
// completeWorkflowStep, from ./advance.ts) is passed in rather than imported:
// advance.ts dispatches the next group through this module, so importing it
// back would be a circular import.

import type { Workflow } from '../workflows.js';
import { checkpointWorkflowRun, notify, snapshot, type WorkflowRun } from './state.js';
import { spawnWorkflowStep } from './stepSpawner.js';
import { activeStepIndices, isWorkflowStepActive, setStepPhase } from './execution.js';
import { executeControlStep, type CompleteStepCallback } from './controlStep.js';
import { dispatchRunTestsStep } from './testStep/runTestsStep.js';
import { failWorkflowRun } from './failRun.js';

// Picks the right executor for a step. Agent steps run through the existing
// pty-pre-spawn path; control steps (start/merge/push) run through the
// headless control-step worker, which calls completeWorkflowStep itself when
// finished (we pass it in to avoid a circular import).
export async function dispatchStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  completeWorkflowStep: CompleteStepCallback,
): Promise<void> {
  if (run.definitionError) throw new Error(run.definitionError);
  if (!isWorkflowStepActive(run, stepIndex)) return;
  const kind = wf.steps[stepIndex].kind ?? 'agent';
  if (kind !== 'agent' && activeStepIndices(run).length > 1) throw new Error('action steps cannot run in parallel');
  if (kind === 'agent') {
    await spawnWorkflowStep(wf, run, stepIndex, backendOrigin);
    return;
  }
  if (kind === 'test') {
    // Run tests is an agent step (it spawns through spawnWorkflowStep and
    // completes through the /complete route), but its skip check, lock wait
    // and USER_WIP capture run DETACHED — like a control step — so a skip
    // doesn't advance recursively inside the previous step's completion.
    // The phase stays `pending` until its pty is requested, which is what a
    // restart re-dispatches.
    notify({ type: 'progress', run: snapshot(run) });
    dispatchRunTestsStep(wf, run, stepIndex, backendOrigin, completeWorkflowStep);
    return;
  }
  // Agent steps emit `progress` from stepSpawner once their pty is ready;
  // control steps have no such moment, so the run-strip would otherwise
  // never see the new `currentStepIndex` until the control step finishes.
  // Emit progress here so the UI advances as soon as the control step
  // begins.
  setStepPhase(run, stepIndex, 'running');
  await checkpointWorkflowRun(run);
  if (run.status !== 'running' || run.currentStepIndex !== stepIndex) return;
  notify({ type: 'progress', run: snapshot(run) });
  // Fire-and-forget. The control step's worker calls completeWorkflowStep
  // when its async work finishes (or marks the run errored on failure).
  executeControlStep(wf, run, stepIndex, backendOrigin, completeWorkflowStep);
}

export async function dispatchGroup(wf: Workflow, run: WorkflowRun, backendOrigin: string,
  completeWorkflowStep: CompleteStepCallback,
  dispatch: typeof dispatchStep = dispatchStep): Promise<void> {
  const indices = [...activeStepIndices(run)];
  await Promise.all(indices.map(async (index) => {
    try { await dispatch(wf, run, index, backendOrigin, completeWorkflowStep); }
    catch (err) {
      if (isWorkflowStepActive(run, index)) {
        if (run.stepStates?.[index]) run.stepStates[index].error = (err as Error).message;
        setStepPhase(run, index, 'errored');
        failWorkflowRun(run.id, `workflow step ${index + 1}: ${(err as Error).message ?? 'setup failed'}`);
      }
      throw err;
    }
  }));
}
