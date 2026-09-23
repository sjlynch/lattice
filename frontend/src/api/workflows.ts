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

// By-id workflow calls carry the ACTIVE project as `?project=` (mirrors
// `taskByIdUrl`): the backend 404s a workflow / run that belongs to another
// project when the param is sent, and treats an absent one as unpinned. An
// empty project omits it.
export function withProjectParam(url: string, projectPath: string): string {
  return projectPath ? `${url}?project=${encodeURIComponent(projectPath)}` : url;
}

export async function updateWorkflow(
  projectPath: string,
  id: string,
  updates: { name?: string; steps?: WorkflowStep[]; variables?: WorkflowVariable[] },
): Promise<Workflow> {
  return patchJson<Workflow>(
    withProjectParam(`/api/workflows/${encodeURIComponent(id)}`, projectPath),
    updates,
  );
}

export async function deleteWorkflow(projectPath: string, id: string): Promise<void> {
  await deleteJson<{ ok: true }>(
    withProjectParam(`/api/workflows/${encodeURIComponent(id)}`, projectPath),
  );
}

export async function startWorkflow(
  id: string,
  options: WorkflowRunStartOptions = {},
): Promise<WorkflowRunResult> {
  const harnessOverride = options.harnessOverride ?? options.modelOverride ?? null;
  const body: Record<string, unknown> = {};
  if (harnessOverride) {
    body.harnessOverride = harnessOverride;
    if (options.piModelOverride) body.piModelOverride = options.piModelOverride;
  }
  // The backend 409s any start while a run is already active for the project
  // (one workflow run per project). asJson throws an HttpError(409) the caller
  // branches on to requeue.
  const url = `/api/workflows/${encodeURIComponent(id)}/run`;
  return Object.keys(body).length > 0
    ? postJson<WorkflowRunResult>(url, body)
    : postJson<WorkflowRunResult>(url);
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

export async function cancelWorkflowRun(projectPath: string, runId: string): Promise<void> {
  await postJson<{ ok: true }>(
    withProjectParam(`/api/workflow-runs/${encodeURIComponent(runId)}/cancel`, projectPath),
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
