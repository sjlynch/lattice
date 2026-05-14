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

export type SelectedHarnessCommand = {
  harness: TaskHarness;
  commandBuilder: CommandBuilder;
  createSession: (args: {
    taskFile: string;
    cwd: string;
  }) => Promise<{ command: string; serverId?: string }>;
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
      }
      return {
        command,
        serverId: 'id' in sess ? sess.id : undefined,
      };
    },
  };
}
