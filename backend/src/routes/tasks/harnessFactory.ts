import {
  buildClaudeCommand,
  buildResumeCommand,
  buildPiCommand,
  buildPiResumeCommand,
  buildCodexCommand,
  buildCodexResumeCommand,
} from '../../worktree.js';
import { proxyCreateSession } from '../../terminalProxy.js';
import type { Task } from '../../tasks.js';
import { normalizeAgentHarness, type AgentHarness } from '../../harnesses.js';
import { taskTerminalLabel } from '../../terminalRegistry/labels.js';
import type { AgentSessionRef } from '../../terminalRegistry/types.js';

export type TaskHarness = AgentHarness;
export type HarnessMode = 'run' | 'resume';

type CommandBuilder = (taskFile: string) => string;

type SelectHarnessCommandOptions = {
  requestedHarness: unknown;
  mode: HarnessMode;
  // Resolved Pi model ("provider/model"); only applied when the harness is
  // `pi`. The caller (startTask/resumeTask) does the body→task→settings
  // resolution; this just binds it into the Pi command builder.
  piModel?: string;
  // Resolved `--yolo` toggle; only applied when the harness is `codex`. The
  // caller resolves it from UserSettings.codexYolo (default ON); this binds it
  // into the Codex command builder. Absent means "use the default (ON)".
  codexYolo?: boolean;
  // When set, the pty is created with THIS command instead of the mode's
  // builder — the true-resume path (resumeTask.ts hands in a
  // `--resume <id>`-style command that continues the previous conversation).
  commandOverride?: string;
};

export type CreateSessionOutcome = {
  command: string;
  serverId?: string;
  // Durable registry tab id + the pinned harness conversation, when a pty
  // was created (see terminalRegistry/).
  terminalId?: string;
  agentSession?: AgentSessionRef;
  // True when the spawn was rejected by the terminal-server's hard cap.
  // Callers turn this into a SpawnCapacityError so the spawn can be deferred.
  // Every other allocation error rejects createSession with its exact message.
  capHit?: boolean;
};

export type SelectedHarnessCommand = {
  harness: TaskHarness;
  commandBuilder: CommandBuilder;
  createSession: (args: {
    taskFile: string;
    cwd: string;
  }) => Promise<CreateSessionOutcome>;
};

function getCommandBuilder(
  harness: TaskHarness,
  mode: HarnessMode,
  piModel?: string,
  codexYolo?: boolean,
): CommandBuilder {
  if (mode === 'resume') {
    if (harness === 'pi') return (taskFile) => buildPiResumeCommand(taskFile, piModel);
    if (harness === 'codex') return (taskFile) => buildCodexResumeCommand(taskFile, codexYolo);
    return buildResumeCommand;
  }

  if (harness === 'pi') return (taskFile) => buildPiCommand(taskFile, piModel);
  if (harness === 'codex') return (taskFile) => buildCodexCommand(taskFile, codexYolo);
  return buildClaudeCommand;
}

export function selectHarnessCommand(
  task: Task,
  options: SelectHarnessCommandOptions,
  deps = { proxyCreateSession },
): SelectedHarnessCommand {
  const harness = normalizeAgentHarness(options.requestedHarness);
  const commandBuilder = getCommandBuilder(
    harness,
    options.mode,
    options.piModel,
    options.codexYolo,
  );

  return {
    harness,
    commandBuilder,
    async createSession({ taskFile, cwd }) {
      const command = options.commandOverride ?? commandBuilder(taskFile);
      const sess = await deps.proxyCreateSession({
        cwd,
        initialCommand: command,
        projectPath: task.projectPath,
        // The one spawn site that knows its task. Lets the resolver bake
        // LATTICE_TASK_ID into the `lattice` MCP server's env (see
        // terminalServerClient/createSession.ts) for both run and resume.
        taskId: task.id,
        // A task agent in its worktree: only the Lattice MCP server, when the
        // project's `taskAgentsLatticeMcpOnly` is on (mcp/taskWorktreeScope.ts).
        mcpScope: 'task-worktree',
        registry: {
          owner: 'task',
          label: taskTerminalLabel(task.title),
          taskId: task.id,
          ...(harness === 'pi' && options.piModel ? { piModel: options.piModel } : {}),
        },
      });
      if ('error' in sess) {
        console.warn(
          `[${options.mode}] task ${task.id}: pre-spawn failed: ${sess.error}`,
        );
        if (sess.code === 'CAP') return { command, capHit: true };
        // In particular, preserve an uncertain outcome verbatim. Retrying it
        // here or treating it as capacity could launch a duplicate agent.
        throw new Error(sess.error);
      }
      return {
        command,
        serverId: sess.id,
        terminalId: sess.terminalId,
        agentSession: sess.agentSession,
      };
    },
  };
}
