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

export type TaskHarness = AgentHarness;
export type HarnessMode = 'run' | 'resume';

type CommandBuilder = (taskFile: string) => string;

type SelectHarnessCommandOptions = {
  requestedHarness: unknown;
  mode: HarnessMode;
};

export type CreateSessionOutcome = {
  command: string;
  serverId?: string;
  // True when the spawn was rejected by the terminal-server's hard cap.
  // The queue path turns this into a SpawnCapacityError so the spawn is
  // re-queued; the un-queued workflow control-step path ignores it and
  // proceeds without a terminal (today's behaviour).
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

function getCommandBuilder(harness: TaskHarness, mode: HarnessMode): CommandBuilder {
  if (mode === 'resume') {
    return harness === 'pi'
      ? buildPiResumeCommand
      : harness === 'codex'
      ? buildCodexResumeCommand
      : buildResumeCommand;
  }

  return harness === 'pi'
    ? buildPiCommand
    : harness === 'codex'
    ? buildCodexCommand
    : buildClaudeCommand;
}

export function selectHarnessCommand(
  task: Task,
  options: SelectHarnessCommandOptions,
): SelectedHarnessCommand {
  const harness = normalizeAgentHarness(options.requestedHarness);
  const commandBuilder = getCommandBuilder(harness, options.mode);

  return {
    harness,
    commandBuilder,
    async createSession({ taskFile, cwd }) {
      const command = commandBuilder(taskFile);
      const sess = await proxyCreateSession({
        cwd,
        initialCommand: command,
        projectPath: task.projectPath,
      });
      if ('error' in sess) {
        console.warn(
          `[${options.mode}] task ${task.id}: pre-spawn failed: ${sess.error}`,
        );
        return { command, capHit: sess.code === 'CAP' };
      }
      return { command, serverId: sess.id };
    },
  };
}
