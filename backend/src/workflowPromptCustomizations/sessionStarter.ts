import { queuedCreateSession } from '../queuedCreateSession.js';
import type { AgentHarness } from '../harnesses.js';
import {
  buildClaudeCommand,
  buildCodexCommand,
  buildPiCommand,
} from '../worktree/commands.js';
import type { WorkflowPromptCustomization } from './types.js';

export function buildCustomizationCommand(
  instructionsFile: string,
  harness: AgentHarness,
  piModel?: string,
): string {
  if (harness === 'pi') return buildPiCommand(instructionsFile, piModel);
  if (harness === 'codex') return buildCodexCommand(instructionsFile);
  return buildClaudeCommand(instructionsFile);
}

export async function preSpawnCustomizationSession(
  request: WorkflowPromptCustomization,
): Promise<void> {
  // `interactive` band — user-initiated, infrequent.
  const sess = await queuedCreateSession({
    kind: 'workflow-prompt-customization',
    priority: 'interactive',
    dedupeKey: `wf-prompt:${request.id}`,
    opts: {
      cwd: request.cwd,
      initialCommand: request.command,
      projectPath: request.projectPath,
    },
  });
  if ('error' in sess) {
    console.warn(
      `[workflow-prompt-customization] ${request.id}: pre-spawn failed: ${sess.error}`,
    );
  } else {
    request.serverId = sess.id;
  }
}
