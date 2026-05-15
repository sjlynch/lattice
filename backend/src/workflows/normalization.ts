import { generateWorkflowId } from '../ids.js';
import { canonicalProjectPath } from '../projectPath.js';
import {
  isAgentHarness,
  normalizeAgentHarness,
} from '../harnesses.js';
import type {
  Workflow,
  WorkflowRunHarnessOverride,
  WorkflowStep,
  WorkflowStepHarness,
} from './types.js';

export function normalizeWorkflowStepHarness(value: unknown): WorkflowStepHarness {
  return normalizeAgentHarness(value);
}

export function normalizeWorkflowRunHarnessOverride(
  value: unknown,
): WorkflowRunHarnessOverride {
  return isAgentHarness(value) ? value : null;
}

export function normalizeSteps(steps: unknown): WorkflowStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s, i) => {
    const step = (s && typeof s === 'object' ? s : {}) as Partial<WorkflowStep>;
    return {
      ...step,
      id: step.id || `step_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
      title: typeof step.title === 'string' ? step.title : '',
      prompt: typeof step.prompt === 'string' ? step.prompt : '',
      mode: step.mode === 'parallel' ? 'parallel' : 'sequential',
      harness: normalizeWorkflowStepHarness(step.harness),
    };
  });
}

export function normalizeWorkflows(raw: unknown, projectPath: string): Workflow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((w) => {
    const item = (w && typeof w === 'object' ? w : {}) as Partial<Workflow>;
    const embeddedProject =
      typeof item.projectPath === 'string' && item.projectPath
        ? canonicalProjectPath(item.projectPath)
        : projectPath;
    return {
      ...item,
      id: typeof item.id === 'string' && item.id ? item.id : generateWorkflowId(),
      projectPath: embeddedProject,
      name:
        typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : 'Untitled workflow',
      steps: normalizeSteps(item.steps),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    };
  });
}
