import fs from 'node:fs/promises';
import { generateWorkflowPromptCustomizationId } from '../ids.js';
import { normalizeAgentHarness } from '../harnesses.js';
import { canonicalProjectPath } from '../projectPath.js';
import { renderCustomizationInstructions } from './instructionRenderer.js';
import {
  customizationDir,
  customizationInstructionsFile,
  submitScriptFile,
  submittedPromptFile,
} from './paths.js';
import {
  cloneWorkflowPromptCustomization,
  getMutableWorkflowPromptCustomization,
  storeWorkflowPromptCustomization,
} from './registry.js';
import {
  buildCustomizationCommand,
  preSpawnCustomizationSession,
} from './sessionStarter.js';
import { renderSubmitScript } from './submitScriptRenderer.js';
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
  if (!input.project) throw new Error('project required');
  const originalPrompt = typeof input.prompt === 'string' ? input.prompt : '';
  const customInstructions = input.customInstructions?.trim();
  if (!originalPrompt.trim() && !customInstructions) {
    throw new Error('prompt or customization instructions required');
  }

  const projectPath = canonicalProjectPath(input.project);
  const id = generateWorkflowPromptCustomizationId();
  const cwd = customizationDir(projectPath, id);
  const harness = normalizeAgentHarness(input.harness);
  const request: WorkflowPromptCustomization = {
    id,
    projectPath,
    stepTitle: input.stepTitle?.trim() || 'Untitled step',
    originalPrompt,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.templateTitle ? { templateTitle: input.templateTitle } : {}),
    ...(customInstructions ? { customInstructions } : {}),
    harness,
    status: 'running',
    createdAt: Date.now(),
    command: '',
    cwd,
  };

  await fs.mkdir(cwd, { recursive: true });
  const instructionsFile = customizationInstructionsFile(cwd);
  await fs.writeFile(
    submitScriptFile(cwd),
    renderSubmitScript(`${backendOrigin}/api/workflow-prompt-customizations/${id}/complete`),
    'utf8',
  );
  await fs.writeFile(
    instructionsFile,
    renderCustomizationInstructions(request),
    'utf8',
  );

  const command = buildCustomizationCommand(instructionsFile, harness);
  request.command = command;
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
