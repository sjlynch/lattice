// Command-string builders for spawning Claude / Pi inside a worktree.
// All builders return a single-line shell command suitable for the UI to
// pipe into a fresh terminal session.

import {
  buildAgentCommand,
  promptFileName,
} from '../agentCommandBuilder.js';

export {
  buildPiModelFlag,
  normalizePiModel,
} from '../agentCommandBuilder.js';

export function buildClaudeCommand(taskFile: string): string {
  const fileName = promptFileName(taskFile);
  return buildAgentCommand({
    harness: 'claude',
    prompt: `Please read ${fileName} and complete the task described in it.`,
  });
}

export function buildResumeCommand(taskFile: string): string {
  const fileName = promptFileName(taskFile);
  return buildAgentCommand({
    harness: 'claude',
    prompt: `Please read ${fileName} and continue this task. Run 'git log --oneline -10' and 'git status' first to see any existing progress before deciding what to do next; don't redo work that's already committed.`,
  });
}

export function buildPiCommand(taskFile: string, piModel?: string): string {
  const fileName = promptFileName(taskFile);
  return buildAgentCommand({
    harness: 'pi',
    piModel,
    prompt: `Please read ${fileName} and complete the task described in it.`,
  });
}

export function buildPiResumeCommand(taskFile: string, piModel?: string): string {
  const fileName = promptFileName(taskFile);
  return buildAgentCommand({
    harness: 'pi',
    piModel,
    prompt: `Please read ${fileName} and continue this task. Run 'git log --oneline -10' and 'git status' first to see any existing progress before deciding what to do next; don't redo work that's already committed.`,
  });
}

export function buildCodexCommand(taskFile: string): string {
  const fileName = promptFileName(taskFile);
  return buildAgentCommand({
    harness: 'codex',
    prompt: `Please read ${fileName} and complete the task described in it.`,
  });
}

export function buildCodexResumeCommand(taskFile: string): string {
  const fileName = promptFileName(taskFile);
  return buildAgentCommand({
    harness: 'codex',
    prompt: `Please read ${fileName} and continue this task. Run 'git log --oneline -10' and 'git status' first to see any existing progress before deciding what to do next; don't redo work that's already committed.`,
  });
}

export function buildConflictResolveCommand(relativeInstructionsPath: string): string {
  return buildAgentCommand({
    harness: 'claude',
    prompt: `Please read ${relativeInstructionsPath} and follow the steps to resolve the merge conflict.`,
  });
}

export function buildStashResolveCommand(relativeInstructionsPath: string): string {
  return buildAgentCommand({
    harness: 'claude',
    prompt: `Please read ${relativeInstructionsPath} and follow the steps to resolve the stash-pop conflict.`,
  });
}
