import { generateWorkflowId } from '../ids.js';
import {
  isAgentHarness,
  normalizeAgentHarness,
} from '../harnesses.js';
import { normalizePiModel } from '../worktree/commands.js';
import {
  RUN_TESTS_MAX_TIMEOUT_MINUTES,
  RUN_TESTS_MIN_TIMEOUT_MINUTES,
  WORKFLOW_STEP_TOOLS,
  type Workflow,
  type WorkflowRunHarnessOverride,
  type WorkflowStep,
  type WorkflowStepHarness,
  type WorkflowStepKind,
  type WorkflowStepTool,
  type WorkflowVariable,
} from './types.js';

const STEP_KINDS = new Set<WorkflowStepKind>(['agent', 'start', 'merge', 'push', 'test']);
const STEP_TOOLS = new Set<string>(WORKFLOW_STEP_TOOLS);

// Known tool ids only, deduplicated, in catalog order; `undefined` (never `[]`)
// when nothing is set so the field stays out of the JSON — the `frozen` /
// `piModel` shape convention.
export function normalizeStepTools(value: unknown): WorkflowStepTool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const wanted = new Set(value.filter((t): t is string => typeof t === 'string' && STEP_TOOLS.has(t)));
  const out = WORKFLOW_STEP_TOOLS.filter((t) => wanted.has(t));
  return out.length ? [...out] : undefined;
}

// A Run tests step's timeout: an integer number of minutes clamped to
// [RUN_TESTS_MIN_TIMEOUT_MINUTES, RUN_TESTS_MAX_TIMEOUT_MINUTES]; `undefined`
// (= the 60-minute default) for anything that isn't a finite number, so the
// field stays out of the JSON unless the user set it.
export function normalizeTestTimeoutMinutes(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.min(
    RUN_TESTS_MAX_TIMEOUT_MINUTES,
    Math.max(RUN_TESTS_MIN_TIMEOUT_MINUTES, Math.round(n)),
  );
}

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
    // The legacy per-step `mode` is dropped here — the spread below would
    // otherwise carry it forward from disk or an old editor draft forever.
    const { mode: _legacyMode, ...step } = (s && typeof s === 'object' ? s : {}) as Partial<WorkflowStep>;
    const kind = normalizeStepKind(step.kind);
    return {
      ...step,
      id: step.id || `step_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
      title: typeof step.title === 'string' ? step.title : '',
      prompt: typeof step.prompt === 'string' ? step.prompt : '',
      harness: normalizeWorkflowStepHarness(step.harness),
      piModel: normalizePiModel(step.piModel),
      kind,
      // Only a literal `true` freezes a step, and `undefined` (not `false`)
      // keeps the flag out of the JSON for the overwhelmingly common
      // not-frozen case — same shape convention as `piModel`.
      frozen: step.frozen === true ? true : undefined,
      tools: normalizeStepTools(step.tools),
      // Only a Run tests step has a timeout; the spread above would otherwise
      // carry a stray one on any other kind forever.
      timeoutMinutes: kind === 'test' ? normalizeTestTimeoutMinutes(step.timeoutMinutes) : undefined,
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
    return {
      ...item,
      id: typeof item.id === 'string' && item.id ? item.id : generateWorkflowId(),
      // The project that OWNS the workflows.json always wins over the path
      // embedded in each record. A copied/moved project keeps the old absolute
      // path in its file, and honouring it made that project's workflows run
      // against (merge into, push from) the ORIGINAL repo.
      projectPath,
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
