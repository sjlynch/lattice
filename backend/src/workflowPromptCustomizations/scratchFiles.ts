import fs from 'node:fs/promises';
import { renderCustomizationInstructions } from './instructionRenderer.js';
import { renderSubmitScript } from './submitScriptRenderer.js';
import {
  customizationInstructionsFile,
  submitScriptFile,
} from './paths.js';
import type { WorkflowPromptCustomization } from './types.js';

// Create the customization scratch dir and write the two model-facing files:
// the `submit-customized-prompt.cjs` callback helper and the
// `CUSTOMIZE_PROMPT.md` brief. Backstop wiring is separate (see backstops.ts).
export async function materializeCustomizationScratch(
  request: WorkflowPromptCustomization,
  callbackUrl: string,
): Promise<void> {
  await fs.mkdir(request.cwd, { recursive: true });
  await fs.writeFile(
    submitScriptFile(request.cwd),
    renderSubmitScript(callbackUrl),
    'utf8',
  );
  await fs.writeFile(
    customizationInstructionsFile(request.cwd),
    renderCustomizationInstructions(request),
    'utf8',
  );
}
