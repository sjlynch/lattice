// Shared "resume an in-progress task" helper.
//
// Extracted from routes/tasks/resumeRoute.ts so the spawn queue can drive
// the same code path the HTTP /resume route uses. Re-spawns the harness pty
// in the task's existing worktree.
//
// Two flavours:
//   - TRUE resume: when the task (or its registry record) knows the harness
//     conversation the previous agent ran (`agentSession`) and the requested
//     harness matches, the new pty continues THAT conversation
//     (`claude --resume <id>` / `pi --session-id <id>` / `codex resume <id>`)
//     with the "continue this task" prompt as its first message. The agent
//     keeps everything it had read and decided.
//   - FRESH resume (the pre-registry behaviour): a new session with the
//     "continue this task, check git log first" prompt.

import path from 'node:path';
import { getTask, updateTask, type Task, type TaskUpdates } from '../../tasks.js';
import { worktreeExists } from '../../worktree.js';
import { SpawnCapacityError } from '../../spawnQueue.js';
import { isAgentHarness, normalizeAgentHarness, type AgentHarness } from '../../harnesses.js';
import { normalizePiModel, resolvePiModel } from '../../piModels.js';
import { isCodexYoloEnabled } from '../../userSettings.js';
import { buildRestoreCommand } from '../../terminalRegistry/restoreCommand.js';
import { claudeTranscriptPath } from '../../terminalRegistry/harnessPaths.js';
import { fileExists } from '../../terminalRegistry/interruption.js';
import { terminalRegistry } from '../../terminalRegistry/store.js';
import type { AgentSessionRef, TerminalRecord } from '../../terminalRegistry/types.js';
import { selectHarnessCommand } from './harnessFactory.js';

export type ResumeTaskByIdResult = {
  task: Task;
  worktreePath: string;
  command: string;
  serverId?: string;
  terminalId?: string;
};

export type ResumeTaskByIdOptions = {
  // See StartTaskByIdOptions.throwOnCapacity — same contract.
  throwOnCapacity?: boolean;
};

const RESUME_PROMPT =
  "Please continue this task. Run 'git log --oneline -10' and 'git status' first " +
  "to see any existing progress before deciding what to do next; don't redo work " +
  "that's already committed.";

// The task's registry records (newest first), or none when the registry is
// unreadable.
async function taskRecords(task: Task): Promise<TerminalRecord[]> {
  try {
    const records = await terminalRegistry.list(task.projectPath, { includeEnded: true });
    return records
      .filter((r) => r.owner === 'task' && r.taskId === task.id)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

// The conversation the previous agent ran: the task's own record first, else
// the registry's task-owned record (a Codex id is discovered there after the
// fact and may not have been copied back onto the task yet).
function knownAgentSession(task: Task, records: TerminalRecord[]): AgentSessionRef | undefined {
  if (task.agentSession) return { ...task.agentSession, source: 'minted' };
  return records.find((r) => r.agentSession)?.agentSession;
}

// Build the true-resume command for a task, or null when there is nothing to
// continue (no known session, harness mismatch, or the previous launch
// command is unknown).
export async function buildTaskResumeCommand(
  task: Task,
  harness: 'claude' | 'pi' | 'codex',
  deps = { taskRecords, fileExists },
): Promise<string | null> {
  const records = await deps.taskRecords(task);
  const session = knownAgentSession(task, records);
  if (!session || session.harness !== harness) return null;
  const launch = records.find((r) => r.launch.initialCommand)?.launch;
  if (!launch?.initialCommand) return null;
  const transcriptExists = harness === 'claude'
    ? await deps.fileExists(claudeTranscriptPath(task.worktreePath!, session.id))
    : false;
  const built = buildRestoreCommand({
    launch,
    agentSession: session,
    claudeTranscriptExists: transcriptExists,
    nudge: RESUME_PROMPT,
  });
  // A Claude session that never reached its first turn has nothing to
  // resume; the fresh path (original prompt) is the right thing there.
  if (built.mode !== 'resume' || !built.command) return null;
  return built.command;
}

// The harness a resume spawns: an explicit (valid) request wins, else the
// harness the task was actually run with (`Task.harness`, recorded at spawn),
// else Claude. Without the task fallback, a body-less /resume of a Pi or Codex
// task silently re-spawned it under Claude.
export function resolveResumeHarness(
  requestedHarness: unknown,
  task: Pick<Task, 'harness'>,
): AgentHarness {
  if (isAgentHarness(requestedHarness)) return requestedHarness;
  return normalizeAgentHarness(task.harness);
}

// Re-validates the task (status, worktree on disk) and re-spawns the pty.
// Re-validation matters because a queued resume's thunk can run minutes
// after the route accepted it. Throws on any precondition failure.
export async function resumeTaskById(
  taskId: string,
  requestedHarness: unknown,
  options: ResumeTaskByIdOptions = {},
  requestedPiModel?: unknown,
): Promise<ResumeTaskByIdResult> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (task.status !== 'in_progress') {
    throw new Error(`task ${taskId} is "${task.status}", expected "in_progress"`);
  }
  if (!task.worktreePath) {
    throw new Error(`task ${taskId} has no worktree path on record`);
  }
  if (!(await worktreeExists(task.worktreePath))) {
    throw new Error(
      `Worktree directory not found at ${task.worktreePath}. ` +
        `The worktree may have been removed manually.`,
    );
  }

  const taskFile = path.join(task.worktreePath, 'LATTICE_TASK.md');
  // Harness: explicit request wins, else the task's recorded harness (see
  // resolveResumeHarness). Pi model for the resume: explicit request wins,
  // else the model the task originally ran with, else the per-project default.
  const harness = resolveResumeHarness(requestedHarness, task);
  const piModel =
    harness === 'pi'
      ? normalizePiModel(requestedPiModel) ??
        normalizePiModel(task.piModel) ??
        (await resolvePiModel(task.projectPath))
      : undefined;
  // Resolve the Codex `--yolo` toggle only for a Codex resume (default ON).
  const codexYolo =
    harness === 'codex' ? await isCodexYoloEnabled(task.projectPath) : undefined;
  const commandOverride = (await buildTaskResumeCommand(task, harness)) ?? undefined;
  const selectedHarness = selectHarnessCommand(task, {
    requestedHarness: harness,
    mode: 'resume',
    piModel,
    codexYolo,
    commandOverride,
  });
  const spawn = await selectedHarness.createSession({
    taskFile,
    cwd: task.worktreePath,
  });
  if (spawn.capHit && options.throwOnCapacity) {
    throw new SpawnCapacityError(
      `task ${taskId}: no terminal slot (terminal-server hard cap)`,
    );
  }
  // A fresh resume pins a NEW conversation; remember it for the next one.
  // Likewise record the harness (+ Pi model) this resume actually ran, so an
  // explicit harness switch sticks for the next body-less resume.
  const patch: TaskUpdates = {};
  if (spawn.agentSession && spawn.agentSession.id !== task.agentSession?.id) {
    patch.agentSession = { harness: spawn.agentSession.harness, id: spawn.agentSession.id };
  }
  if (
    spawn.serverId &&
    (task.harness !== harness || (harness === 'pi' && task.piModel !== piModel))
  ) {
    patch.harness = harness;
    patch.piModel = harness === 'pi' ? piModel : undefined;
  }
  if (Object.keys(patch).length > 0) await updateTask(task.id, patch);

  return {
    task,
    worktreePath: task.worktreePath,
    command: spawn.command,
    serverId: spawn.serverId,
    terminalId: spawn.terminalId,
  };
}
