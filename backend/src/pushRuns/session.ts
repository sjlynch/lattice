import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureTrustedClaudeDir } from '../claudeTrust.js';
import { proxyCreateSession } from '../terminalProxy.js';
import { renderPushInstructions } from './instructions.js';
import { assertSafePushSessionPath, createPushSessionId } from './paths.js';
import { recordPushRun } from './registry.js';
import { installPushStopHook } from './stopHook.js';
import { cleanupPushSession } from './cleanup.js';
import type { PushSession } from './types.js';

// Materialize the per-session directory in home-scoped scratch: writes the
// instructions brief and installs the Stop hook so Claude calls
// /api/push-runs/:id/done on stop.
export async function setupPushSession(
  projectPath: string,
  backendOrigin: string,
): Promise<PushSession> {
  const id = createPushSessionId();
  const cwd = assertSafePushSessionPath(projectPath, id);
  await fs.mkdir(cwd, { recursive: true });

  // Pre-accept the workspace-trust dialog for this brand-new dir; otherwise
  // Claude prompts on first launch and blocks the unattended push flow.
  await ensureTrustedClaudeDir(cwd);

  await installPushStopHook(cwd, id, backendOrigin);

  const instructionsFile = path.join(cwd, 'PUSH_INSTRUCTIONS.md');
  await fs.writeFile(instructionsFile, renderPushInstructions(projectPath), 'utf8');

  return { id, cwd, instructionsFile };
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
  const session = await setupPushSession(projectPath, backendOrigin);
  const command = `claude --dangerously-skip-permissions "Please read PUSH_INSTRUCTIONS.md in this directory and follow it."`;
  const sess = await proxyCreateSession({
    cwd: session.cwd,
    initialCommand: command,
    projectPath,
  });
  if ('error' in sess) {
    await cleanupPushSession(projectPath, session.id);
    throw new Error(sess.error);
  }
  recordPushRun({
    id: session.id,
    projectPath,
    cwd: session.cwd,
    status: 'running',
    createdAt: Date.now(),
  });
  return {
    id: session.id,
    cwd: session.cwd,
    command,
    serverId: sess.id,
  };
}
