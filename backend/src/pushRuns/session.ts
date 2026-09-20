import { setupHomeScratchSession } from '../homeScratch/session.js';
import { createHomeScratchAgentSession } from '../homeScratch/agentSession.js';
import { buildAgentCommand } from '../agentCommandBuilder.js';
import { renderPushInstructions } from './instructions.js';
import { resolveInstructionTemplate } from '../instructionTemplates.js';
import { pushPaths } from './paths.js';
import { recordPushRun } from './registry.js';
import { installPushStopHook, pushAgentId } from './stopHook.js';
import { cleanupPushSession } from './cleanup.js';
import type { PushSession } from './types.js';

const PUSH_INSTRUCTIONS_FILE = 'PUSH_INSTRUCTIONS.md';
const PUSH_COMMAND = buildAgentCommand({
  harness: 'claude',
  prompt: 'Please read PUSH_INSTRUCTIONS.md in this directory and follow it.',
});

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
  terminalId?: string;
};

// The shared mirror skeleton (command, queue metadata, presence node, cleanup).
// Only the push-specific brief, hook install, and registry record are passed in
// per call by `startPushSession`.
const startPushAgentSession = createHomeScratchAgentSession({
  paths: pushPaths,
  instructionsFileName: PUSH_INSTRUCTIONS_FILE,
  command: PUSH_COMMAND,
  queueKind: 'push-run',
  dedupeKeyPrefix: 'push',
  agentId: pushAgentId,
  presenceLabel: 'push',
  cleanup: cleanupPushSession,
});

// Full push-session spawn: materialize the session dir, pre-spawn the Claude
// pty, and record the run. Shared between the /api/push-runs HTTP route and
// the workflow Push control step so both go through identical setup.
//
// Throws on terminal spawn failure (after cleaning up the scratch dir).
export async function startPushSession(
  projectPath: string,
  backendOrigin: string,
): Promise<StartedPushSession> {
  const started = await startPushAgentSession({
    projectPath,
    installHooks: ({ cwd, id }) =>
      installPushStopHook(cwd, id, backendOrigin, projectPath),
    renderInstructions: () => renderPush(projectPath),
    recordRun: ({ id, cwd }) =>
      recordPushRun({
        id,
        projectPath,
        cwd,
        status: 'running',
        createdAt: Date.now(),
      }),
  });
  return {
    id: started.id,
    cwd: started.cwd,
    command: started.command,
    serverId: started.serverId,
    terminalId: started.terminalId,
  };
}
