// Shared fixtures for the split workflowPushStepCancel.* suites (cancel,
// registry, timeout, admission): a running one-step Push workflow run and a
// setImmediate-paced `waitFor`. Not a `*.test.ts` file, so it isn't collected
// as a suite.
import type { WorkflowRun } from '../../workflowRuns/state.js';
import type { Workflow } from '../../workflows.js';

export const PROJECT = '/project';

export function makeRun(): WorkflowRun {
  return {
    id: 'wfrun_push_cancel',
    workflowId: 'wf',
    workflowName: 'wf',
    projectPath: PROJECT,
    status: 'running',
    startedAt: 1,
    totalSteps: 1,
    currentStepIndex: 0,
  };
}

export function makeWorkflow(): Workflow {
  return { projectPath: PROJECT, steps: [{ kind: 'push' }] } as Workflow;
}

export async function waitFor(pred: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('waitFor: condition never became true');
}
