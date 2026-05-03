// Workflow CRUD, run start, and live subscriptions for both definitions
// and runs.

import { asJson } from './http';
import { subscribeWs } from './ws';
import type {
  Workflow,
  WorkflowRunEvent,
  WorkflowRunResult,
  WorkflowStep,
} from './types';

export async function fetchWorkflows(projectPath: string): Promise<Workflow[]> {
  return asJson<Workflow[]>(
    await fetch(`/api/workflows?project=${encodeURIComponent(projectPath)}`),
  );
}

export async function createWorkflow(
  projectPath: string,
  name: string,
  steps: WorkflowStep[],
): Promise<Workflow> {
  return asJson<Workflow>(
    await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath, name, steps }),
    }),
  );
}

export async function updateWorkflow(
  id: string,
  updates: { name?: string; steps?: WorkflowStep[] },
): Promise<Workflow> {
  return asJson<Workflow>(
    await fetch(`/api/workflows/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }),
  );
}

export async function deleteWorkflow(id: string): Promise<void> {
  await asJson<{ ok: true }>(
    await fetch(`/api/workflows/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  );
}

export async function startWorkflow(id: string): Promise<WorkflowRunResult> {
  return asJson<WorkflowRunResult>(
    await fetch(`/api/workflows/${encodeURIComponent(id)}/run`, {
      method: 'POST',
    }),
  );
}

export function subscribeWorkflows(
  projectPath: string,
  onUpdate: (workflows: Workflow[]) => void,
): () => void {
  return subscribeWs<{ type: string; workflows?: Workflow[] }>(
    `/ws/workflows?project=${encodeURIComponent(projectPath)}`,
    (msg) => {
      if (msg.type === 'workflows' && msg.workflows) onUpdate(msg.workflows);
    },
  );
}

export function subscribeWorkflowRuns(
  projectPath: string,
  onEvent: (ev: WorkflowRunEvent) => void,
): () => void {
  return subscribeWs<WorkflowRunEvent>(
    `/ws/workflow-runs?project=${encodeURIComponent(projectPath)}`,
    onEvent,
  );
}
