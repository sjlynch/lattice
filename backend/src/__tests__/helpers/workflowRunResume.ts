// Shared fixture for the split workflowRunResume.* suites (mirror, restore,
// heldStop): a running workflow-run record as the on-disk mirror holds it.
// Not a `*.test.ts` file, so it isn't collected as a suite.
import { canonicalProjectPath } from '../../projectPath.js';
import type { WorkflowRun } from '../../workflowRuns/state.js';

export function fakeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'wfrun_resume_1',
    workflowId: 'wf-resume',
    workflowName: 'Refactor',
    projectPath: canonicalProjectPath('C:/resume-project'),
    status: 'running',
    startedAt: 1_700_000_000_000,
    totalSteps: 7,
    currentStepIndex: 3,
    ...overrides,
  };
}
