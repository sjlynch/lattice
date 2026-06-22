import { generateWorkflowId } from '../ids.js';
import { canonicalProjectPath } from '../projectPath.js';
import {
  isAgentHarness,
  normalizeAgentHarness,
} from '../harnesses.js';
import { normalizePiModel } from '../worktree/commands.js';
import type {
  Workflow,
  WorkflowRunHarnessOverride,
  WorkflowStep,
  WorkflowStepHarness,
  WorkflowStepKind,
  WorkflowVariable,
} from './types.js';

const STEP_KINDS = new Set<WorkflowStepKind>(['agent', 'start', 'merge', 'push']);

// The built-in variable every workflow carries. Built-in workflow steps end
// with `{{user_instructions}}`, so its value is injected at the bottom of each
// step prompt at run time. Defaults to empty (a no-op substitution).
export const USER_INSTRUCTIONS_VAR = 'user_instructions';

// Variable names are referenced as `{{name}}`, so they must match the same
// token grammar the interpolator recognizes: letters, digits, underscores.
export function normalizeVariableName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeStepKind(value: unknown): WorkflowStepKind {
  return typeof value === 'string' && STEP_KINDS.has(value as WorkflowStepKind)
    ? (value as WorkflowStepKind)
    : 'agent';
}

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
      piModel: normalizePiModel(step.piModel),
      kind: normalizeStepKind(step.kind),
    };
  });
}

export function normalizeVariables(raw: unknown): WorkflowVariable[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WorkflowVariable[] = [];
  raw.forEach((v, i) => {
    const item = (v && typeof v === 'object' ? v : {}) as Partial<WorkflowVariable>;
    const name = normalizeVariableName(item.name);
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({
      id:
        typeof item.id === 'string' && item.id
          ? item.id
          : `var_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
      name,
      value: typeof item.value === 'string' ? item.value : '',
    });
  });
  return out;
}

// Guarantee the built-in `user_instructions` variable is always present
// (first, so it leads the editor list). Idempotent.
export function ensureUserInstructions(vars: WorkflowVariable[]): WorkflowVariable[] {
  if (vars.some((v) => v.name === USER_INSTRUCTIONS_VAR)) return vars;
  return [
    {
      id: `var_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      name: USER_INSTRUCTIONS_VAR,
      value: '',
    },
    ...vars,
  ];
}

export function normalizeWorkflowVariables(raw: unknown): WorkflowVariable[] {
  return ensureUserInstructions(normalizeVariables(raw));
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
      variables: normalizeWorkflowVariables(item.variables),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    };
  });
}
