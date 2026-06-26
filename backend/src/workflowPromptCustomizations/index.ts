import fs from 'node:fs/promises';
import { installCustomizationBackstops } from './backstops.js';
import { submittedPromptFile } from './paths.js';
import {
  cloneWorkflowPromptCustomization,
  getMutableWorkflowPromptCustomization,
  storeWorkflowPromptCustomization,
} from './registry.js';
import { normalizeCustomizationRequest } from './requestNormalizer.js';
import { materializeCustomizationScratch } from './scratchFiles.js';
import {
  preSpawnCustomizationSession,
  resolveCustomizationCommand,
} from './sessionStarter.js';
import type {
  StartWorkflowPromptCustomizationInput,
  WorkflowPromptCustomization,
} from './types.js';

export type {
  StartWorkflowPromptCustomizationInput,
  WorkflowPromptCustomization,
  WorkflowPromptCustomizationStatus,
  WorkflowPromptTemplateId,
} from './types.js';
export { getWorkflowPromptCustomization } from './registry.js';

export async function startWorkflowPromptCustomization(
  input: StartWorkflowPromptCustomizationInput,
  backendOrigin: string,
): Promise<WorkflowPromptCustomization> {
  const request = normalizeCustomizationRequest(input);
  const callbackUrl = `${backendOrigin}/api/workflow-prompt-customizations/${request.id}/complete`;

  await materializeCustomizationScratch(request, callbackUrl);
  await installCustomizationBackstops(request, callbackUrl);

  request.command = await resolveCustomizationCommand(request);
  storeWorkflowPromptCustomization(request);
  await preSpawnCustomizationSession(request);

  return cloneWorkflowPromptCustomization(request);
}

export async function completeWorkflowPromptCustomization(
  id: string,
  prompt: unknown,
): Promise<WorkflowPromptCustomization | null> {
  const request = getMutableWorkflowPromptCustomization(id);
  if (!request) return null;
  // Idempotent: once a customization reaches a terminal status, later
  // /complete calls are no-ops. The always-installed Stop-hook backstop
  // re-POSTs after the model already submitted a good prompt; if
  // CUSTOMIZED_PROMPT.md is gone at Stop time it POSTs {prompt:''}, which
  // without this guard would overwrite a 'completed' record to 'errored'
  // and make a polling frontend discard a perfectly good customization.
  if (request.status !== 'running') {
    return cloneWorkflowPromptCustomization(request);
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    request.status = 'errored';
    request.error = 'customized prompt was empty';
    request.finishedAt = Date.now();
    return cloneWorkflowPromptCustomization(request);
  }
  request.status = 'completed';
  request.resultPrompt = prompt.replace(/\r\n/g, '\n').trim();
  request.finishedAt = Date.now();
  try {
    await fs.writeFile(
      submittedPromptFile(request.cwd),
      request.resultPrompt,
      'utf8',
    );
  } catch {
    // Best-effort audit copy only.
  }
  return cloneWorkflowPromptCustomization(request);
}
