import type {
  HarnessAvailability,
  WorkflowRunHarnessOverride,
  WorkflowStepHarness,
} from '../../api';

export const DEFAULT_WORKFLOW_HARNESS_VALUE = 'default';

export function serializeWorkflowHarnessOverride(
  value: WorkflowRunHarnessOverride,
): string {
  return value ?? DEFAULT_WORKFLOW_HARNESS_VALUE;
}

export function parseWorkflowHarnessOverride(
  value: string,
): WorkflowRunHarnessOverride {
  return value === 'claude' || value === 'pi' || value === 'codex'
    ? value
    : null;
}

export function workflowHarnessOverrideLabel(
  value: WorkflowRunHarnessOverride | undefined,
): string {
  if (value === 'claude') return 'Claude';
  if (value === 'pi') return 'Pi';
  if (value === 'codex') return 'Codex';
  return 'Default';
}

export function availableWorkflowHarnessOptions(
  harnessAvail: HarnessAvailability,
  selected: WorkflowRunHarnessOverride,
): WorkflowStepHarness[] {
  const options: WorkflowStepHarness[] = ['claude'];
  if (harnessAvail.pi || selected === 'pi') options.push('pi');
  if (harnessAvail.codex || selected === 'codex') options.push('codex');
  return options;
}
