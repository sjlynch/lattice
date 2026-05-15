// Persistent workflow definitions per project — public facade.
//
// A Workflow is an ordered chain of prompts. When run, each step becomes a
// regular Lattice task; finishing one auto-spawns the next (see workflowRuns.ts).
// Storage remains `<project>/.lattice/workflows.json`; ProjectStateManager owns
// the canonical-project cache, lazy disk load, debounced persistence, and
// subscriber fan-out mechanics via workflows/store.ts.

import { WorkflowStore } from './workflows/store.js';
import type {
  Workflow,
  WorkflowStep,
  WorkflowSubscriber,
} from './workflows/types.js';

export type {
  Workflow,
  WorkflowRunHarnessOverride,
  WorkflowStep,
  WorkflowStepHarness,
  WorkflowStepMode,
  WorkflowSubscriber,
} from './workflows/types.js';
export {
  normalizeSteps,
  normalizeWorkflowRunHarnessOverride,
  normalizeWorkflowStepHarness,
  normalizeWorkflows,
} from './workflows/normalization.js';
export {
  WORKFLOWS_FILENAME,
  workflowsFile,
  WorkflowStore,
} from './workflows/store.js';

const workflowStore = new WorkflowStore();

export function subscribe(fn: WorkflowSubscriber): () => void {
  return workflowStore.subscribe(fn);
}

export async function listWorkflows(projectPath: string): Promise<Workflow[]> {
  return workflowStore.listWorkflows(projectPath);
}

export async function getWorkflow(id: string): Promise<Workflow | null> {
  return workflowStore.getWorkflow(id);
}

export async function createWorkflow(
  projectPath: string,
  name: string,
  steps: WorkflowStep[] | undefined,
): Promise<Workflow> {
  return workflowStore.createWorkflow(projectPath, name, steps);
}

export async function updateWorkflow(
  id: string,
  updates: { name?: string; steps?: WorkflowStep[] },
): Promise<Workflow | null> {
  return workflowStore.updateWorkflow(id, updates);
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  return workflowStore.deleteWorkflow(id);
}
