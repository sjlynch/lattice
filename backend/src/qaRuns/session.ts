import { createHomeScratchAgentSession } from '../homeScratch/agentSession.js';
import { buildAgentCommand } from '../agentCommandBuilder.js';
import { renderQaInstructions } from './instructions.js';
import { resolveInstructionTemplate } from '../instructionTemplates.js';
import { qaPaths } from './paths.js';
import { recordQaRun } from './registry.js';
import { installQaStopHook, qaAgentId } from './stopHook.js';
import { cleanupQaSession } from './cleanup.js';

export type StartQaSessionArgs = {
  projectPath: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  backendOrigin: string;
};

const QA_INSTRUCTIONS_FILE = 'QA_INSTRUCTIONS.md';
const QA_COMMAND = buildAgentCommand({
  harness: 'claude',
  prompt: 'Please read QA_INSTRUCTIONS.md in this directory and run the end-to-end test it describes using the Playwright MCP browser tools.',
});

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

// The shared mirror skeleton (command, queue metadata, presence node, cleanup),
// with `isQaRun: true` so the MCP injection chokepoint adds the QA-scoped
// Playwright (with the QA lane's headed/headless choice — the only spawn that
// resolves `qaPlaywright`); ordinary task spawns never set it. Only the
// QA-specific brief, hook install, and registry record are passed in per call by
// `startQaSession`.
const startQaAgentSession = createHomeScratchAgentSession({
  paths: qaPaths,
  instructionsFileName: QA_INSTRUCTIONS_FILE,
  command: QA_COMMAND,
  queueKind: 'qa-run',
  dedupeKeyPrefix: 'qa',
  isQaRun: true,
  agentId: qaAgentId,
  presenceLabel: 'qa',
  cleanup: cleanupQaSession,
});

// Full QA e2e-session spawn: materialize the session dir (home-scoped scratch,
// cwd = scratch, agent cds into the project), pre-spawn the Claude pty (with
// `projectPath` + `isQaRun` so the QA-lane Playwright MCP is injected), and
// record the run. Throws on terminal spawn failure (after cleaning up scratch).
// Mirrors pushRuns/session.ts via the shared `createHomeScratchAgentSession`
// factory.
export async function startQaSession(
  args: StartQaSessionArgs,
): Promise<StartedQaSession> {
  const started = await startQaAgentSession({
    projectPath: args.projectPath,
    installHooks: ({ cwd, id }) =>
      installQaStopHook(cwd, id, args.backendOrigin, args.projectPath),
    renderInstructions: ({ id }) => renderQa(args, id),
    recordRun: ({ id, cwd }) =>
      recordQaRun({
        id,
        taskId: args.taskId,
        projectPath: args.projectPath,
        cwd,
        status: 'running',
        createdAt: Date.now(),
      }),
  });
  return {
    id: started.id,
    taskId: args.taskId,
    cwd: started.cwd,
    command: started.command,
    serverId: started.serverId,
  };
}
