import fs from 'node:fs/promises';
import { generateWorkflowPromptCustomizationId } from '../ids.js';
import { normalizeAgentHarness } from '../harnesses.js';
import { canonicalProjectPath } from '../projectPath.js';
import { installClaudeStopHookForCommand } from '../claudeStopHook.js';
import { installPiCompletionExtension } from '../piExtension.js';
import { installPiSubagentsShim } from '../piSubagents.js';
import { renderCustomizationBackstopScript } from './backstopScripts.js';
import { renderCustomizationInstructions } from './instructionRenderer.js';
import {
  backstopScriptFile,
  customizationDir,
  customizationInstructionsFile,
  customizedPromptFile,
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
  const callbackUrl = `${backendOrigin}/api/workflow-prompt-customizations/${id}/complete`;
  await fs.writeFile(
    submitScriptFile(cwd),
    renderSubmitScript(callbackUrl),
    'utf8',
  );
  await fs.writeFile(
    instructionsFile,
    renderCustomizationInstructions(request),
    'utf8',
  );

  // Backstops (the customization site historically had none — if the model
  // forgot to call `submit-customized-prompt.cjs`, the request hung in
  // `running` forever).
  //
  // Both backstops are always installed regardless of the active harness
  // (defence-in-depth, same rule as workflow steps + post-merge hooks): the
  // unused one is inert. The customization /complete endpoint expects a JSON
  // body `{prompt}`, so neither backstop can just curl an empty URL — both
  // do the right thing instead:
  //   - Claude Stop hook runs `node lattice-customization-backstop.cjs`,
  //     which reads CUSTOMIZED_PROMPT.md and POSTs it as JSON. If the file
  //     is missing it POSTs `{prompt: ""}` with `?error=...` so the request
  //     transitions to `errored` instead of staying `running` forever.
  //   - Pi extension uses piExtension.ts's `promptFile` mode for the same
  //     read-and-POST behavior, plus a sentinel audit log for diagnostics.
  // Pi gate is disabled here (any shutdown reason fires) — no PTY-kill side
  // effect and idempotent on the server side.
  const backstopPath = backstopScriptFile(cwd);
  await fs.writeFile(backstopPath, renderCustomizationBackstopScript(callbackUrl), 'utf8');
  await installClaudeStopHookForCommand(cwd, `node ${JSON.stringify(backstopPath)}`);
  await installPiCompletionExtension({
    dir: cwd,
    callbackUrl,
    site: 'workflow-customization-complete',
    respectQuitGate: false,
    promptFile: customizedPromptFile(cwd),
  });
  // pi-subagents loader shim alongside the completion extension (no-op until
  // the shared install resolves). Scratch is under <project>/.lattice/ (gitignored).
  await installPiSubagentsShim({ dir: cwd });
  console.log(
    `[workflow-customization] installed Claude+Pi backstops for ${id} ` +
      `(active harness=${harness}, cwd=${cwd})`,
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
