import path from 'node:path';
import fs from 'node:fs/promises';
import {
  installClaudeStopHook,
  renderClaudeStopHookConfig,
} from '../claudeStopHook.js';
import {
  installPiCompletionExtension as installPiCompletionExtensionShared,
} from '../piExtension.js';

// Write patterns to the worktree-local git exclude file so these files
// are invisible to `git status` inside the worktree. The exclude file
// lives in the worktree's gitdir (resolved from the .git pointer file)
// and is never committed — unlike .gitignore which is part of the tree.
export async function writeWorktreeExclude(worktreePath: string, patterns: string[]): Promise<void> {
  try {
    const gitPointer = await fs.readFile(path.join(worktreePath, '.git'), 'utf8');
    const gitDirRelative = gitPointer.trim().replace(/^gitdir:\s*/i, '');
    const gitDir = path.resolve(worktreePath, gitDirRelative);
    const infoDir = path.join(gitDir, 'info');
    await fs.mkdir(infoDir, { recursive: true });
    await fs.appendFile(
      path.join(infoDir, 'exclude'),
      `\n# Lattice-managed — do not commit\n${patterns.join('\n')}\n`,
      'utf8',
    );
  } catch (err) {
    // Non-fatal: the merge path already handles the shelve-and-restore
    // fallback; this is belt-and-suspenders prevention only.
    console.warn('[worktree] could not write local exclude file:', err);
  }
}

// Claude hook config — Stop hook posts back so the task moves to QA.
// Written into <worktree>/.claude/settings.local.json so it's scoped to
// just that worktree's Claude session.
//
// Exported as `renderStopHookJson` so the validation/repair path in the
// merge route can rebuild the file from the same template Lattice uses
// at setup time.
// The `?source=` tag lets the /complete route log which mechanism fired
// (Claude Stop hook curl vs. Pi extension fetch vs. model explicit curl)
// when a callback lands.
function taskCompleteUrlForStopHook(taskId: string, backendOrigin: string): string {
  return `${backendOrigin}/api/tasks/${taskId}/complete?source=claude-stop-hook-task-complete`;
}

export function renderStopHookJson(taskId: string, backendOrigin: string): string {
  return renderClaudeStopHookConfig(
    taskCompleteUrlForStopHook(taskId, backendOrigin),
  );
}

export async function installStopHook(
  worktreePath: string,
  taskId: string,
  backendOrigin: string,
): Promise<void> {
  await installClaudeStopHook(
    worktreePath,
    taskCompleteUrlForStopHook(taskId, backendOrigin),
  );
}

// Pi has no settings-driven command hooks (it's deliberately minimal — no
// MCP, no permission popups, no command hooks). What it does have is a
// TypeScript extension system: any `*.ts` under `<cwd>/.pi/extensions/` is
// auto-loaded — no settings.json entry needed — and runs in Node, so it can
// `fetch()` the same `/complete` callback the Claude Stop hook curls.
//
// We gate on `event.reason === 'quit'` here (`respectQuitGate: true`) so an
// in-session `/new`, `/reload`, or `/fork` (which also emit
// `session_shutdown`) doesn't flip the task early. The task `/complete`
// route schedules a 1s pty kill on transition, which would yank a `/fork`'d
// pty out from under an interactive user — workflow-step and post-merge
// callbacks have no such side effect, so those sites disable the gate (see
// piExtension.ts).
//
// This is a backstop: LATTICE_TASK.md already tells the Pi model to POST
// `/complete` itself as its final step. The extension covers the case where
// the model errors out or forgets. Both calls landing is harmless.
//
// Logging: the rendered extension writes a sentinel JSON file
// (`<worktree>/.pi/extensions/lattice-last-shutdown.json`) recording the
// reason, attempt count, outcome, and any error message — so "did the
// extension fire? did the POST succeed?" is visible without server logs.
export async function installPiCompletionExtension(
  worktreePath: string,
  taskId: string,
  backendOrigin: string,
): Promise<void> {
  await installPiCompletionExtensionShared({
    dir: worktreePath,
    callbackUrl: `${backendOrigin}/api/tasks/${taskId}/complete`,
    site: 'task-complete',
    respectQuitGate: true,
  });
}
