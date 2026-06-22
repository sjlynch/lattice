// Command-string builders for spawning Claude / Pi inside a worktree.
// All builders return a single-line shell command suitable for the UI to
// pipe into a fresh terminal session.

import path from 'node:path';

// A Pi model selector is a `provider/model` pattern, optionally with a
// `:thinking`-style suffix (e.g. `qwen-local/qwen`, `openai-codex/gpt-5.5`).
// Restrict to the character set those patterns actually use so a value coming
// from settings / request bodies can be interpolated into a shell command line
// without opening an injection surface. Anything else is rejected (→ Pi's own
// default model is used).
const PI_MODEL_PATTERN_RE =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?$/;

// Coerce an untrusted value to a safe Pi model pattern, or `undefined`.
export function normalizePiModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return PI_MODEL_PATTERN_RE.test(trimmed) ? trimmed : undefined;
}

// The single place that turns a resolved Pi model into a `--model` flag (and
// the only place that quotes it). Empty string when no/invalid model so the
// session falls back to Pi's configured default.
export function buildPiModelFlag(piModel?: string): string {
  const model = normalizePiModel(piModel);
  return model ? ` --model "${model}"` : '';
}

export function buildClaudeCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `claude --dangerously-skip-permissions "Please read ${fileName} and complete the task described in it."`;
}

export function buildResumeCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `claude --dangerously-skip-permissions "Please read ${fileName} and continue this task. Run 'git log --oneline -10' and 'git status' first to see any existing progress before deciding what to do next; don't redo work that's already committed."`;
}

export function buildPiCommand(taskFile: string, piModel?: string): string {
  const fileName = path.basename(taskFile);
  return `pi${buildPiModelFlag(piModel)} "Please read ${fileName} and complete the task described in it."`;
}

export function buildPiResumeCommand(taskFile: string, piModel?: string): string {
  const fileName = path.basename(taskFile);
  return `pi${buildPiModelFlag(piModel)} "Please read ${fileName} and continue this task. Run 'git log --oneline -10' and 'git status' first to see any existing progress before deciding what to do next; don't redo work that's already committed."`;
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
