// Worktree creation: takes a Task and produces an isolated git worktree
// + branch + Claude Stop-hook config (+ a Pi completion extension when the
// task runs under Pi) + LATTICE_TASK.md brief.
//
// Reconciles stale state from a prior half-failed run before creating, so
// that "Run" is always a fresh start. Resume uses a different code path
// (in routes/tasks.ts) that preserves prior progress.

import path from 'node:path';
import fs from 'node:fs/promises';
import type { Task } from '../tasks.js';
import { exec } from './exec.js';
import { projectGit } from './projectGit.js';
import { renderTaskMarkdown } from './instructions.js';
import { homeWorktreesDir } from '../projectPath.js';
import { LATTICE_EXCLUDE_PATTERNS } from './managedFiles.js';
import {
  MAX_PATH_RETRY_SUFFIXES,
  reconcileStaleState,
} from './reconcile.js';
import {
  ensureLatticeGitignore,
  ensureLatticeRepoExclude,
  untrackOwnedFilesInRepo,
} from './projectGuards.js';
import {
  installPiCompletionExtension,
  installStopHook,
  writeWorktreeExclude,
} from './stopHook.js';

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}

export type WorktreeResult = {
  worktreePath: string;
  branch: string;
  taskFile: string;
};

// Worktrees live OUTSIDE the project tree, under
// `~/.lattice/worktrees/<projectHash>/` (see `homeWorktreesDir` in
// projectPath.ts). Rationale — the headline fix after three `.git`-deletion
// incidents: when a per-task scratch checkout is nested inside the project
// (`<repo>/.lattice/worktrees/<id>`), any recursive delete Lattice issues
// on a worktree path is one bad path component away from resolving to
// `<repo>/.git`, and `git status` in the project enumerates those nested
// checkouts (the gitignore-failure that fed the 2026-05-08/09 cascade).
// Hoisting them out of the project makes the whole class impossible by
// construction — the same move already made for `tasks.json`. The only
// thing left inside `<repo>/.git` is the tiny `worktrees/<name>/gitdir`
// pointer file `git worktree add` writes.

export async function setupTaskWorktree(
  repoPath: string,
  task: Task,
  backendOrigin: string,
  harness: 'claude' | 'pi' | 'codex' = 'claude',
): Promise<WorktreeResult> {
  // First call is plain `exec` (not projectGit) so a folder that isn't a
  // git repo at all gets the clear "run `git init`" message rather than
  // projectGit's ".git is missing" assertion.
  const repoCheck = await exec(
    'git',
    ['rev-parse', '--show-toplevel'],
    repoPath,
  );
  if (repoCheck.code !== 0) {
    throw new Error(
      `Not a git repository: ${repoPath}. Initialize one with \`git init\` first.`,
    );
  }
  const repoRoot = repoCheck.stdout.trim();
  // Defend the project against the file-tracking pattern that produces
  // unresolvable merge conflicts in `.claude/settings.local.json`. Cheap,
  // idempotent, and runs before each worktree creation so newly-adopted
  // projects self-heal on first task run.
  await ensureLatticeGitignore(repoRoot);
  await ensureLatticeRepoExclude(repoRoot);
  await untrackOwnedFilesInRepo(repoRoot);
  const slug = slugify(task.title);
  const shortId = task.id.slice(-6);
  const worktreesDir = homeWorktreesDir(repoRoot);
  await fs.mkdir(worktreesDir, { recursive: true });

  // Try the canonical path first; if reconciliation can't free it (Windows
  // file lock from an Explorer window, editor, etc.), fall through to a
  // suffixed path so the user isn't blocked. The branch name follows the
  // same retry suffix so `git worktree add -b` doesn't collide either.
  for (let attempt = 0; attempt <= MAX_PATH_RETRY_SUFFIXES; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-r${attempt + 1}`;
    const candidatePath = path.join(worktreesDir, `${slug}-${shortId}${suffix}`);
    const candidateBranch = `lattice/${slug}-${shortId}${suffix}`;

    const reconciled = await reconcileStaleState(
      repoRoot,
      candidateBranch,
      candidatePath,
    );
    if (!reconciled) {
      // Path or branch couldn't be cleaned. Try the next suffix.
      console.warn(
        `[worktree] could not reconcile ${candidatePath}; trying next suffix`,
      );
      continue;
    }

    const wt = await projectGit(
      repoRoot,
      ['worktree', 'add', candidatePath, '-b', candidateBranch],
    );
    if (wt.code !== 0) {
      // `git worktree add` itself failed (rare after reconcile). Log and
      // try the next suffix rather than throwing — same recovery model.
      console.warn(
        `[worktree] git worktree add ${candidatePath} -b ${candidateBranch} ` +
          `(cwd=${repoRoot}) exit ${wt.code}: ` +
          `${wt.stderr.trim() || wt.stdout.trim() || '(no output)'}; ` +
          `trying next suffix`,
      );
      continue;
    }

    const taskFile = path.join(candidatePath, 'LATTICE_TASK.md');
    await fs.writeFile(taskFile, renderTaskMarkdown(task, backendOrigin, harness), 'utf8');
    // The Claude Stop hook is installed for every worktree regardless of run
    // harness: a Pi/Codex task that later hits a merge conflict spawns a
    // *Claude* resolver, which relies on this hook to call `/complete`.
    await installStopHook(candidatePath, task.id, backendOrigin);
    // Pi has no command-hook mechanism; install its TypeScript-extension
    // equivalent so the in-worktree Pi session reports completion on exit.
    if (harness === 'pi') {
      await installPiCompletionExtension(candidatePath, task.id, backendOrigin);
    }
    // Keep Lattice-managed files out of `git status` so Claude's `git add .`
    // never stages them. Writes to the worktree-local exclude (not the repo
    // .gitignore) so the project's tracked files are untouched.
    await writeWorktreeExclude(candidatePath, [...LATTICE_EXCLUDE_PATTERNS]);

    if (attempt > 0) {
      console.log(
        `[worktree] used fallback path ${candidatePath} for task ${task.id} ` +
          `(canonical was locked; orphan dir at ${path.join(worktreesDir, `${slug}-${shortId}`)} ` +
          `will need manual cleanup once the lock holder is closed)`,
      );
    }

    return {
      worktreePath: candidatePath,
      branch: candidateBranch,
      taskFile,
    };
  }

  throw new Error(
    `Could not create a worktree for task "${task.title}" after ` +
      `${MAX_PATH_RETRY_SUFFIXES + 1} attempts: every candidate path under ` +
      `${path.join(worktreesDir, `${slug}-${shortId}`)}* is locked or unusable. ` +
      `Close any process / editor / Explorer window holding those directories ` +
      `open and try again.`,
  );
}

export {
  ensureLatticeGitignore,
  ensureLatticeRepoExclude,
  untrackOwnedFilesInRepo,
  verifyEssentialExclusions,
} from './projectGuards.js';

export {
  installPiCompletionExtension,
  installStopHook,
  renderPiCompletionExtension,
  renderStopHookJson,
} from './stopHook.js';
