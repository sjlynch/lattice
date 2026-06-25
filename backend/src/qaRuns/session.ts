import { startHomeScratchAgentSession } from '../homeScratch/session.js';
import { renderQaInstructions } from './instructions.js';
import { resolveInstructionTemplate } from '../instructionTemplates.js';
import { qaPaths } from './paths.js';
import { recordQaRun } from './registry.js';
import { installQaStopHook, qaAgentId } from './stopHook.js';
import { cleanupQaSession } from './cleanup.js';
import { registerAgentSession } from '../agentSessions.js';

export type StartQaSessionArgs = {
  projectPath: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  backendOrigin: string;
};

const QA_INSTRUCTIONS_FILE = 'QA_INSTRUCTIONS.md';
const QA_COMMAND =
  'claude --dangerously-skip-permissions "Please read QA_INSTRUCTIONS.md in this directory and run the end-to-end test it describes using the Playwright MCP browser tools."';

async function renderQa(
  args: StartQaSessionArgs,
  qaRunId: string,
): Promise<string> {
  const template = await resolveInstructionTemplate(args.projectPath, 'qa');
  return renderQaInstructions({
    projectPath: args.projectPath,
    qaRunId,
    taskId: args.taskId,
    taskTitle: args.taskTitle,
    taskDescription: args.taskDescription,
    backendOrigin: args.backendOrigin,
    template,
  });
}

export type StartedQaSession = {
  id: string;
  taskId: string;
  cwd: string;
  command: string;
  serverId?: string;
};

// Full QA e2e-session spawn: materialize the session dir (home-scoped scratch,
// cwd = scratch, agent cds into the project), pre-spawn the Claude pty (with
// `projectPath` + `isQaRun` so the QA-lane Playwright MCP is injected), and
// record the run. Throws on terminal spawn failure (after cleaning up scratch).
// Mirrors pushRuns/session.ts via the shared `startHomeScratchAgentSession`
// builder.
export async function startQaSession(
  args: StartQaSessionArgs,
): Promise<StartedQaSession> {
  const started = await startHomeScratchAgentSession({
    paths: qaPaths,
    projectPath: args.projectPath,
    instructionsFileName: QA_INSTRUCTIONS_FILE,
    installHooks: ({ cwd, id }) =>
      installQaStopHook(cwd, id, args.backendOrigin, args.projectPath),
    renderInstructions: ({ id }) => renderQa(args, id),
    buildCommand: () => QA_COMMAND,
    // `interactive` band — user-initiated, infrequent; may use PRIORITY_RESERVE
    // headroom so a QA run is not stuck behind a full batch lane.
    queueKind: 'qa-run',
    queuePriority: 'interactive',
    dedupeKeyPrefix: 'qa',
    // `isQaRun` opts this session into the QA-scoped Playwright (`qaPlaywright`)
    // at the injection chokepoint — Playwright + the QA lane's headed/headless
    // choice. Ordinary task spawns don't set it, so the QA toggle never leaks
    // into them; they only get Playwright via the global `mcpOverrides` toggle.
    isQaRun: true,
    onSpawned: ({ id, cwd, serverId }) => {
      recordQaRun({
        id,
        taskId: args.taskId,
        projectPath: args.projectPath,
        cwd,
        status: 'running',
        createdAt: Date.now(),
      });
      // Presence: show an orange Claude node for this non-worktree session.
      registerAgentSession({
        agentId: qaAgentId(id),
        projectPath: args.projectPath,
        label: 'qa',
      });
    },
    cleanup: cleanupQaSession,
  });
  return {
    id: started.id,
    taskId: args.taskId,
    cwd: started.cwd,
    command: started.command,
    serverId: started.serverId,
  };
}
