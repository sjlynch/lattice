import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureTrustedClaudeDir } from '../claudeTrust.js';
import { queuedCreateSession } from '../queuedCreateSession.js';
import { renderQaInstructions } from './instructions.js';
import { assertSafeQaSessionPath, createQaSessionId } from './paths.js';
import { recordQaRun } from './registry.js';
import { installQaStopHook, qaAgentId } from './stopHook.js';
import { cleanupQaSession } from './cleanup.js';
import { registerAgentSession } from '../agentSessions.js';
import type { QaSession } from './types.js';

export type StartQaSessionArgs = {
  projectPath: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  backendOrigin: string;
};

// Materialize the per-session scratch dir: writes the QA brief and installs
// the Stop hook so Claude calls /api/qa-runs/:id/done on stop. Mirrors
// pushRuns/session.ts (home-scoped scratch, cwd = scratch, agent cds into the
// project).
async function setupQaSession(args: StartQaSessionArgs): Promise<QaSession> {
  const id = createQaSessionId();
  const cwd = assertSafeQaSessionPath(args.projectPath, id);
  await fs.mkdir(cwd, { recursive: true });

  // Pre-accept the workspace-trust dialog for this brand-new dir; otherwise
  // Claude prompts on first launch and blocks the unattended QA flow.
  await ensureTrustedClaudeDir(cwd);

  await installQaStopHook(cwd, id, args.backendOrigin, args.projectPath);

  const instructionsFile = path.join(cwd, 'QA_INSTRUCTIONS.md');
  await fs.writeFile(
    instructionsFile,
    renderQaInstructions({
      projectPath: args.projectPath,
      taskId: args.taskId,
      taskTitle: args.taskTitle,
      taskDescription: args.taskDescription,
      backendOrigin: args.backendOrigin,
    }),
    'utf8',
  );

  return { id, cwd, instructionsFile };
}

export type StartedQaSession = {
  id: string;
  taskId: string;
  cwd: string;
  command: string;
  serverId?: string;
};

// Full QA e2e-session spawn: materialize the session dir, pre-spawn the Claude
// pty (with `projectPath` so the QA-lane Playwright MCP is injected), and
// record the run. Throws on terminal spawn failure (after cleaning up scratch).
export async function startQaSession(
  args: StartQaSessionArgs,
): Promise<StartedQaSession> {
  const session = await setupQaSession(args);
  const command = `claude --dangerously-skip-permissions "Please read QA_INSTRUCTIONS.md in this directory and run the end-to-end test it describes using the Playwright MCP browser tools."`;
  // `interactive` band — user-initiated, infrequent; may use PRIORITY_RESERVE
  // headroom so a QA run is not stuck behind a full batch lane.
  const sess = await queuedCreateSession({
    kind: 'qa-run',
    priority: 'interactive',
    dedupeKey: `qa:${session.id}`,
    opts: { cwd: session.cwd, initialCommand: command, projectPath: args.projectPath },
  });
  if ('error' in sess) {
    await cleanupQaSession(args.projectPath, session.id);
    throw new Error(sess.error);
  }
  recordQaRun({
    id: session.id,
    taskId: args.taskId,
    projectPath: args.projectPath,
    cwd: session.cwd,
    status: 'running',
    createdAt: Date.now(),
  });
  // Presence: show an orange Claude node for this non-worktree session.
  registerAgentSession({
    agentId: qaAgentId(session.id),
    projectPath: args.projectPath,
    label: 'qa',
  });
  return {
    id: session.id,
    taskId: args.taskId,
    cwd: session.cwd,
    command,
    serverId: sess.id,
  };
}
