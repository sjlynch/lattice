import { generateWorkflowPromptCustomizationId } from '../ids.js';
import { normalizeAgentHarness } from '../harnesses.js';
import { canonicalProjectPath } from '../projectPath.js';
import { customizationDir } from './paths.js';
import type {
  StartWorkflowPromptCustomizationInput,
  WorkflowPromptCustomization,
} from './types.js';

// Validate + normalize a raw start request into a fresh `running`
// customization record. Throws on missing project / empty prompt (the same
// errors the route surfaces to the caller). `command` is left empty here —
// it's resolved once the harness/Pi model are known (see sessionStarter).
export function normalizeCustomizationRequest(
  input: StartWorkflowPromptCustomizationInput,
): WorkflowPromptCustomization {
  if (!input.project) throw new Error('project required');
  const originalPrompt = typeof input.prompt === 'string' ? input.prompt : '';
  const customInstructions = input.customInstructions?.trim();
  if (!originalPrompt.trim() && !customInstructions) {
    throw new Error('prompt or customization instructions required');
  }

  const projectPath = canonicalProjectPath(input.project);
  const id = generateWorkflowPromptCustomizationId();
  return {
    id,
    projectPath,
    stepTitle: input.stepTitle?.trim() || 'Untitled step',
    originalPrompt,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.templateTitle ? { templateTitle: input.templateTitle } : {}),
    ...(customInstructions ? { customInstructions } : {}),
    harness: normalizeAgentHarness(input.harness),
    status: 'running',
    createdAt: Date.now(),
    command: '',
    cwd: customizationDir(projectPath, id),
  };
}
