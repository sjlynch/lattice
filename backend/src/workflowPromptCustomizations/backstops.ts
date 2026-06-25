import fs from 'node:fs/promises';
import { installClaudeStopHookForCommand } from '../claudeStopHook.js';
import { installPiCompletionExtension } from '../piExtension.js';
import { installPiSubagentsShim } from '../piSubagents.js';
import { renderCustomizationBackstopScript } from './backstopScripts.js';
import { backstopScriptFile, customizedPromptFile } from './paths.js';
import type { WorkflowPromptCustomization } from './types.js';

// Install the completion backstops for a customization session.
//
// The customization site historically had none — if the model forgot to call
// `submit-customized-prompt.cjs`, the request hung in `running` forever.
//
// Both backstops are always installed regardless of the active harness
// (defence-in-depth, same rule as workflow steps + post-merge hooks): the
// unused one is inert. The customization /complete endpoint expects a JSON
// body `{prompt}`, so neither backstop can just curl an empty URL — both do
// the right thing instead:
//   - Claude Stop hook runs `node lattice-customization-backstop.cjs`, which
//     reads CUSTOMIZED_PROMPT.md and POSTs it as JSON. If the file is missing
//     it POSTs `{prompt: ""}` with `?error=...` so the request transitions to
//     `errored` instead of staying `running` forever.
//   - Pi extension uses piExtension.ts's `promptFile` mode for the same
//     read-and-POST behavior, plus a sentinel audit log for diagnostics.
// Pi gate is disabled here (any shutdown reason fires) — no PTY-kill side
// effect and idempotent on the server side.
//
// The pi-subagents loader shim is dropped alongside the completion extension
// (no-op until the shared install resolves). Scratch is under
// <project>/.lattice/ (gitignored).
export async function installCustomizationBackstops(
  request: WorkflowPromptCustomization,
  callbackUrl: string,
): Promise<void> {
  const backstopPath = backstopScriptFile(request.cwd);
  await fs.writeFile(
    backstopPath,
    renderCustomizationBackstopScript(callbackUrl),
    'utf8',
  );
  await installClaudeStopHookForCommand(
    request.cwd,
    `node ${JSON.stringify(backstopPath)}`,
  );
  await installPiCompletionExtension({
    dir: request.cwd,
    callbackUrl,
    site: 'workflow-customization-complete',
    respectQuitGate: false,
    promptFile: customizedPromptFile(request.cwd),
  });
  await installPiSubagentsShim({ dir: request.cwd });
  console.log(
    `[workflow-customization] installed Claude+Pi backstops for ${request.id} ` +
      `(active harness=${request.harness}, cwd=${request.cwd})`,
  );
}
