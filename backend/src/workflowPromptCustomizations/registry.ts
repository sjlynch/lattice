import type { WorkflowPromptCustomization } from './types.js';

const requests = new Map<string, WorkflowPromptCustomization>();

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
}
