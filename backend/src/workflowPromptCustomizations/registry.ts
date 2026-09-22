import type { WorkflowPromptCustomization } from './types.js';

const requests = new Map<string, WorkflowPromptCustomization>();

// Finished requests kept for the frontend's poll to read their result. The
// frontend polls one id until it reaches a terminal status and then stops, so
// only the most recent few finished records have any reader; without a bound
// the map grew for the life of the process. Running requests are never pruned.
export const MAX_FINISHED_CUSTOMIZATIONS = 20;

function pruneFinishedCustomizations(): void {
  const finished = [...requests.values()]
    .filter((r) => r.status !== 'running')
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
  for (const stale of finished.slice(MAX_FINISHED_CUSTOMIZATIONS)) {
    requests.delete(stale.id);
  }
}

export function cloneWorkflowPromptCustomization(
  request: WorkflowPromptCustomization,
): WorkflowPromptCustomization {
  return { ...request };
}

export function getWorkflowPromptCustomization(
  id: string,
): WorkflowPromptCustomization | null {
  const request = requests.get(id);
  return request ? cloneWorkflowPromptCustomization(request) : null;
}

export function getMutableWorkflowPromptCustomization(
  id: string,
): WorkflowPromptCustomization | null {
  return requests.get(id) ?? null;
}

export function storeWorkflowPromptCustomization(
  request: WorkflowPromptCustomization,
): void {
  requests.set(request.id, request);
  pruneFinishedCustomizations();
}
