// Command-string builders for spawning Claude / Pi inside a worktree.
// All builders return a single-line shell command suitable for the UI to
// pipe into a fresh terminal session.

import path from 'node:path';

export function buildClaudeCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `claude --dangerously-skip-permissions "Please read ${fileName} and complete the task described in it."`;
}

export function buildResumeCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `claude --dangerously-skip-permissions "Please read ${fileName} and continue this task. Run 'git log --oneline -10' and 'git status' first to see any existing progress before deciding what to do next; don't redo work that's already committed."`;
}

export function buildPiCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `pi "Please read ${fileName} and complete the task described in it."`;
}

export function buildPiResumeCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `pi "Please read ${fileName} and continue this task. Run 'git log --oneline -10' and 'git status' first to see any existing progress before deciding what to do next; don't redo work that's already committed."`;
}

export function buildCodexCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `codex "Please read ${fileName} and complete the task described in it."`;
}

export function buildCodexResumeCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `codex "Please read ${fileName} and continue this task. Run 'git log --oneline -10' and 'git status' first to see any existing progress before deciding what to do next; don't redo work that's already committed."`;
}

export function buildConflictResolveCommand(relativeInstructionsPath: string): string {
  return `claude --dangerously-skip-permissions "Please read ${relativeInstructionsPath} and follow the steps to resolve the merge conflict."`;
}

export function buildStashResolveCommand(relativeInstructionsPath: string): string {
  return `claude --dangerously-skip-permissions "Please read ${relativeInstructionsPath} and follow the steps to resolve the stash-pop conflict."`;
}
