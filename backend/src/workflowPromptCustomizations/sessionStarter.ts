import { queuedCreateSession } from '../queuedCreateSession.js';
import { resolvePiModel } from '../piModels.js';
import { isCodexYoloEnabled } from '../userSettings.js';
import type { AgentHarness } from '../harnesses.js';
import {
  buildClaudeCommand,
  buildCodexCommand,
  buildPiCommand,
} from '../worktree/commands.js';
import { customizationInstructionsFile } from './paths.js';
import type { WorkflowPromptCustomization } from './types.js';

export function buildCustomizationCommand(
  instructionsFile: string,
  harness: AgentHarness,
  piModel?: string,
  codexYolo?: boolean,
): string {
  if (harness === 'pi') return buildPiCommand(instructionsFile, piModel);
  if (harness === 'codex') return buildCodexCommand(instructionsFile, codexYolo);
  return buildClaudeCommand(instructionsFile);
}

// Resolve the harness launch command for a customization session. A
// prompt-customization session has no model picker of its own; when it runs
// under Pi, use the project's default Pi model (UserSettings.piModel). Codex
// picks up the project's `--yolo` toggle (default ON).
export async function resolveCustomizationCommand(
  request: WorkflowPromptCustomization,
): Promise<string> {
  const piModel =
    request.harness === 'pi'
      ? await resolvePiModel(request.projectPath)
      : undefined;
  const codexYolo =
    request.harness === 'codex'
      ? await isCodexYoloEnabled(request.projectPath)
      : undefined;
  return buildCustomizationCommand(
    customizationInstructionsFile(request.cwd),
    request.harness,
    piModel,
    codexYolo,
  );
}

export type PreSpawnCustomizationDeps = {
  queuedCreateSession: typeof queuedCreateSession;
};

export async function preSpawnCustomizationSession(
  request: WorkflowPromptCustomization,
  deps: PreSpawnCustomizationDeps = { queuedCreateSession },
): Promise<void> {
  // `interactive` band — user-initiated, infrequent.
  const sess = await deps.queuedCreateSession({
    kind: 'workflow-prompt-customization',
    priority: 'interactive',
    dedupeKey: `wf-prompt:${request.id}`,
    opts: {
      cwd: request.cwd,
      initialCommand: request.command,
      projectPath: request.projectPath,
      registry: {
        owner: 'prompt-customization',
        label: `customize:${request.stepTitle ?? request.id.slice(-6)}`,
      },
    },
  });
  if ('error' in sess) {
    // A non-CAP spawn failure (CAP is retried inside the queue and never
    // surfaces here). The record must reach a terminal status: left `running`
    // with no serverId, the frontend polled it for its whole budget and the
    // user saw a customization that never started and never failed.
    console.warn(
      `[workflow-prompt-customization] ${request.id}: pre-spawn failed: ${sess.error}`,
    );
    if (request.status === 'running') {
      request.status = 'errored';
      request.error = sess.error;
      request.finishedAt = Date.now();
    }
  } else {
    request.serverId = sess.id;
    request.terminalId = sess.terminalId;
  }
}
