import {
  setupHomeScratchSession,
  startHomeScratchAgentSession,
} from '../homeScratch/session.js';
import { renderPushInstructions } from './instructions.js';
import { resolveInstructionTemplate } from '../instructionTemplates.js';
import { pushPaths } from './paths.js';
import { recordPushRun } from './registry.js';
import { installPushStopHook, pushAgentId } from './stopHook.js';
import { cleanupPushSession } from './cleanup.js';
import { registerAgentSession } from '../agentSessions.js';
import type { PushSession } from './types.js';

const PUSH_INSTRUCTIONS_FILE = 'PUSH_INSTRUCTIONS.md';
const PUSH_COMMAND =
  'claude --dangerously-skip-permissions "Please read PUSH_INSTRUCTIONS.md in this directory and follow it."';

async function renderPush(projectPath: string): Promise<string> {
  const template = await resolveInstructionTemplate(projectPath, 'push');
  return renderPushInstructions(projectPath, template);
}

// Materialize the per-session directory in home-scoped scratch: writes the
// instructions brief and installs the Stop hook so Claude calls
// /api/push-runs/:id/done on stop. Thin wrapper over the shared
// `setupHomeScratchSession` builder.
export async function setupPushSession(
  projectPath: string,
  backendOrigin: string,
): Promise<PushSession> {
  return setupHomeScratchSession({
    paths: pushPaths,
    projectPath,
    instructionsFileName: PUSH_INSTRUCTIONS_FILE,
    installHooks: ({ cwd, id }) =>
      installPushStopHook(cwd, id, backendOrigin, projectPath),
    renderInstructions: () => renderPush(projectPath),
  });
}

export type StartedPushSession = {
  id: string;
  cwd: string;
  command: string;
  serverId?: string;
};

// Full push-session spawn: materialize the session dir, pre-spawn the Claude
// pty, and record the run. Shared between the /api/push-runs HTTP route and
// the workflow Push control step so both go through identical setup.
//
// Throws on terminal spawn failure (after cleaning up the scratch dir).
export async function startPushSession(
  projectPath: string,
  backendOrigin: string,
): Promise<StartedPushSession> {
  const started = await startHomeScratchAgentSession({
    paths: pushPaths,
    projectPath,
    instructionsFileName: PUSH_INSTRUCTIONS_FILE,
    installHooks: ({ cwd, id }) =>
      installPushStopHook(cwd, id, backendOrigin, projectPath),
    renderInstructions: () => renderPush(projectPath),
    buildCommand: () => PUSH_COMMAND,
    // `interactive` band — user-initiated, infrequent; may use PRIORITY_RESERVE
    // headroom so a push is not stuck behind a full batch lane.
    queueKind: 'push-run',
    queuePriority: 'interactive',
    dedupeKeyPrefix: 'push',
    onSpawned: ({ id, cwd, serverId }) => {
      recordPushRun({
        id,
        projectPath,
        cwd,
        status: 'running',
        createdAt: Date.now(),
      });
      // Presence: show an orange Claude node for this non-worktree session.
      registerAgentSession({
        agentId: pushAgentId(id),
        projectPath,
        label: 'push',
      });
    },
    cleanup: cleanupPushSession,
  });
  return {
    id: started.id,
    cwd: started.cwd,
    command: started.command,
    serverId: started.serverId,
  };
}
