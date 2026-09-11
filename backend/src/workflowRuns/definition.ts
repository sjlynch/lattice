import type { Workflow } from '../workflows.js';
import { normalizeSteps, normalizeVariables } from '../workflows/normalization.js';

export function cloneWorkflowDefinition(wf: Workflow): Workflow {
  return { ...wf, steps: wf.steps.map((step) => ({ ...step })), variables: wf.variables.map((v) => ({ ...v })) };
}

// A persisted definition must never silently fall back to today's edited one.
export function readWorkflowDefinition(raw: unknown, workflowId: string, projectPath: string): Workflow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const wf = raw as Partial<Workflow>;
  if (wf.id !== workflowId || typeof wf.name !== 'string' || !Array.isArray(wf.steps) ||
      !wf.steps.every((s) => s && typeof s.id === 'string' && typeof s.prompt === 'string')) return undefined;
  return { id: workflowId, name: wf.name, projectPath, createdAt: typeof wf.createdAt === 'number' ? wf.createdAt : 0,
    steps: normalizeSteps(wf.steps), variables: normalizeVariables(wf.variables) };
}
