import path from 'node:path';
import fs from 'node:fs/promises';
import {
  installClaudeHooks,
  renderClaudeHooksConfig,
} from '../claudeStopHook.js';
import {
  installPiCompletionExtension as installPiCompletionExtensionShared,
} from '../piExtension.js';
import { installCodexStopHook } from '../codexStopHook.js';
import { exec } from './exec.js';
import { appendMissingExcludeEntries } from './projectGuards/repoExclude.js';

// Make Lattice's own files invisible to `git status` inside a worktree, so an
// agent's `git add -A` can never stage (and then commit) them.
//
// THE TARGET IS THE COMMON GITDIR, NOT THE WORKTREE'S OWN.
// This used to resolve the `.git` pointer file to
// `<repo>/.git/worktrees/<name>/` and append there — a file git NEVER READS.
// `info/exclude` is one of git's "common" files: it is only ever read from
// `git rev-parse --git-common-dir` (verified — `git check-ignore` in a linked
// worktree honours the common file and ignores the per-worktree one). So every
// pattern Lattice wrote was inert, and `git status` in a worktree kept showing
// `?? LATTICE_TASK.md`, `?? .codex/hooks.json`. That is how a Lattice-generated
// `.codex/hooks.json` got committed onto main in the first place, which then
// aborted `git merge` in every other worktree with "untracked working tree
// files would be overwritten by merge" — the failure this whole chain of
// defences exists to prevent. `.claude/settings.local.json` looked fine only
// because `ensureLatticeGitignore` lists it in the tracked `.gitignore` too.
//
// The common exclude is shared by every worktree AND the main checkout, so the
// append must be idempotent (it is — appendMissingExcludeEntries skips entries
// already present) rather than the blind append this used to do.
//
// Read-only git on a worktree path ⇒ plain `exec`, not `projectGit`.
export async function writeWorktreeExclude(worktreePath: string, patterns: string[]): Promise<void> {
  try {
    const r = await exec('git', ['rev-parse', '--git-common-dir'], worktreePath);
    if (r.code !== 0 || !r.stdout.trim()) {
      console.warn('[worktree] could not resolve the common gitdir for excludes');
      return;
    }
    await appendMissingExcludeEntries(
      path.resolve(worktreePath, r.stdout.trim()),
      patterns,
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

// PreToolUse/PostToolUse activity callback. The worktree agent POSTs the
// hook JSON here so the graph can draw a focus beam to the file it's
// touching. `.claude/settings.local.json` is only read by Claude, so this
// is installed for every worktree (a Pi/Codex primary task simply never
// fires it; a Claude conflict-resolver in any worktree does). The frontend
// scopes the visible Claude node to `harness === 'claude'` tasks.
function taskActivityUrlForHook(taskId: string, backendOrigin: string): string {
  return `${backendOrigin}/api/tasks/${taskId}/activity?source=claude-tool-hook`;
}

function hookUrls(taskId: string, backendOrigin: string) {
  return {
    completeUrl: taskCompleteUrlForStopHook(taskId, backendOrigin),
    activityUrl: taskActivityUrlForHook(taskId, backendOrigin),
  };
}

export function renderStopHookJson(taskId: string, backendOrigin: string): string {
  return renderClaudeHooksConfig(hookUrls(taskId, backendOrigin));
}

export async function installStopHook(
  worktreePath: string,
  taskId: string,
  backendOrigin: string,
): Promise<void> {
  await installClaudeHooks(worktreePath, hookUrls(taskId, backendOrigin));
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

// Codex Stop hook — the Codex analogue of installStopHook (Claude) /
// installPiCompletionExtension (Pi). Codex's `Stop` event fires once when the
// agent's turn completes and POSTs `/complete`, so a Codex task advances
// reliably even if the model forgets to curl it (previously Codex tasks had NO
// completion backstop — only the model's explicit curl).
//
// Installed as `<worktree>/.codex/hooks.json` under the **`if-absent`** policy:
// the worktree is a repo checkout, so if the repo itself tracks
// `.codex/hooks.json`, Lattice must NOT clobber it — it falls back to the
// model's explicit curl (the caller logs the skip). Our written file is hidden
// from `git status` via LATTICE_EXCLUDE_PATTERNS (worktree-local exclude), so a
// Codex `git add -A` never stages it. Returns false when skipped.
export async function installCodexCompletionHook(
  worktreePath: string,
  taskId: string,
  backendOrigin: string,
): Promise<boolean> {
  return installCodexStopHook(
    worktreePath,
    `${backendOrigin}/api/tasks/${taskId}/complete?source=codex-stop-hook-task-complete`,
    'if-absent',
  );
}
