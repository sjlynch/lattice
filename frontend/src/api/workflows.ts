// Workflow CRUD, run start, and live subscriptions for both definitions
// and runs.

import { asJson, deleteJson, patchJson, postJson } from './http';
import { subscribeWs } from './ws';
import type {
  StartWorkflowPromptCustomizationInput,
  Workflow,
  WorkflowPromptCustomization,
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunResult,
  WorkflowRunStartOptions,
  WorkflowStep,
  WorkflowVariable,
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
  variables?: WorkflowVariable[],
): Promise<Workflow> {
  return postJson<Workflow>('/api/workflows', {
    project: projectPath,
    name,
    steps,
    variables,
  });
}

export async function updateWorkflow(
  id: string,
  updates: { name?: string; steps?: WorkflowStep[]; variables?: WorkflowVariable[] },
): Promise<Workflow> {
  return patchJson<Workflow>(`/api/workflows/${encodeURIComponent(id)}`, updates);
}

export async function deleteWorkflow(id: string): Promise<void> {
  await deleteJson<{ ok: true }>(`/api/workflows/${encodeURIComponent(id)}`);
}

export async function startWorkflow(
  id: string,
  options: WorkflowRunStartOptions = {},
): Promise<WorkflowRunResult> {
  const harnessOverride = options.harnessOverride ?? options.modelOverride ?? null;
  return harnessOverride
    ? postJson<WorkflowRunResult>(`/api/workflows/${encodeURIComponent(id)}/run`, {
        harnessOverride,
        piModelOverride: options.piModelOverride,
      })
    : postJson<WorkflowRunResult>(`/api/workflows/${encodeURIComponent(id)}/run`);
}

// HTTP fallback for the active workflow runs of a project. Authoritative
// snapshot of in-memory server state at the moment of the request. The
// `/ws/workflow-runs` subscription's `hello` event covers the same thing on
// connect — this exists so `useWorkflowRuns` can additively reconcile after
// page mount / tab-visibility transitions where a WS event could have been
// lost (e.g. backend restart with no resume; future-proofing for layer-2
// run persistence).
//
// IMPORTANT: callers should treat the returned list as additive only — do
// not remove runs from local state that the fetch omits, because the fetch
// can race with a `completed` WS event that arrives in between query and
// response. Removal is the WS's job.
export async function fetchActiveWorkflowRuns(
  projectPath: string,
): Promise<WorkflowRun[]> {
  return asJson<WorkflowRun[]>(
    await fetch(
      `/api/workflow-runs/active?project=${encodeURIComponent(projectPath)}`,
    ),
  );
}

export async function cancelWorkflowRun(runId: string): Promise<void> {
  await postJson<{ ok: true }>(
    `/api/workflow-runs/${encodeURIComponent(runId)}/cancel`,
  );
}

export async function startWorkflowPromptCustomization(
  input: StartWorkflowPromptCustomizationInput,
): Promise<WorkflowPromptCustomization> {
  return postJson<WorkflowPromptCustomization>(
    '/api/workflow-prompt-customizations',
    input,
  );
}

export async function getWorkflowPromptCustomization(
  id: string,
): Promise<WorkflowPromptCustomization> {
  return asJson<WorkflowPromptCustomization>(
    await fetch(`/api/workflow-prompt-customizations/${encodeURIComponent(id)}`),
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
