import type {
  HarnessAvailability,
  WorkflowRunHarnessOverride,
  WorkflowStepHarness,
} from '../../api';
import {
  availableAgentHarnesses,
  harnessLabel,
  isAgentHarness,
} from '../../harnesses';

export const DEFAULT_WORKFLOW_HARNESS_VALUE = 'default';

export function serializeWorkflowHarnessOverride(
  value: WorkflowRunHarnessOverride,
): string {
  return value ?? DEFAULT_WORKFLOW_HARNESS_VALUE;
}

export function parseWorkflowHarnessOverride(
  value: string,
): WorkflowRunHarnessOverride {
  return isAgentHarness(value) ? value : null;
}

export function workflowHarnessOverrideLabel(
  value: WorkflowRunHarnessOverride | undefined,
): string {
  return harnessLabel(value);
}

export function availableWorkflowHarnessOptions(
  harnessAvail: HarnessAvailability,
  selected: WorkflowRunHarnessOverride,
): WorkflowStepHarness[] {
  return availableAgentHarnesses(harnessAvail, selected) as WorkflowStepHarness[];
}
