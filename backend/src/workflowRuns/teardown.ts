import { activeStepIndices } from './execution.js';
import type { WorkflowRun } from './state.js';
import { cancelWorkflowStepSessions, workflowStepAgentId } from './sessionSpawner.js';
import { cancelStopHookGate } from './stopHookGate.js';
import { abortStepPreRun } from './stepTools.js';
import { abortRunTestsStep } from './testStep/runTestsStep.js';
import { forgetAgentQuiescence } from '../agentQuiescence.js';
import { unregisterAgentSession } from '../agentSessions.js';

export function teardownWorkflowRun(run: WorkflowRun): void {
  if (run.status === 'errored' && run.stepStates && !Object.values(run.stepStates).some((s) => s.phase === 'errored')) {
    const state = run.stepStates[run.currentStepIndex];
    if (state && state.phase !== 'completed') { state.phase = 'errored'; state.error = run.error; }
  }
  abortStepPreRun(run.id);
  cancelStopHookGate(run.id);
  cancelWorkflowStepSessions(run.id);
  for (const index of activeStepIndices(run)) {
    const id = workflowStepAgentId(run.id, index);
    forgetAgentQuiescence(id);
    unregisterAgentSession(id);
    const state = run.stepStates?.[index];
    if (state && !['completed', 'skipped', 'errored'].includes(state.phase)) state.phase = 'cancelled';
  }
  void abortRunTestsStep(run.id);
}
