// Worktree creation: takes a Task and produces an isolated git worktree
// + branch + Claude Stop-hook config (+ a Pi completion extension when the
// task runs under Pi) + LATTICE_TASK.md brief.
//
// Reconciles stale state from a prior half-failed run before creating, so
// that "Run" is always a fresh start. Resume uses a different code path
// (in routes/tasks.ts) that preserves prior progress.

import fs from 'node:fs/promises';
import type { Task } from '../tasks.js';
import type { AgentHarness } from '../harnesses.js';
import { resolveRepoRootAndPrepareProject } from './setupProject.js';
import { buildWorktreeCandidatePlan } from './setupCandidates.js';
import {
  addWorktreeWithRetries,
  logFallbackWorktreeCandidate,
} from './setupAdd.js';
import { writePostAddWorktreeFiles } from './setupFiles.js';

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
  harness: AgentHarness = 'claude',
): Promise<WorktreeResult> {
  const { repoRoot, envNotes } = await resolveRepoRootAndPrepareProject(repoPath);
  const plan = buildWorktreeCandidatePlan(repoRoot, task);
  await fs.mkdir(plan.worktreesDir, { recursive: true });

  const candidate = await addWorktreeWithRetries(repoRoot, plan, task.title);
  const taskFile = await writePostAddWorktreeFiles(
    candidate.candidatePath,
    task,
    backendOrigin,
    harness,
    envNotes,
  );
  logFallbackWorktreeCandidate(candidate, plan, task.id);

  return {
    worktreePath: candidate.candidatePath,
    branch: candidate.candidateBranch,
    taskFile,
  };
}

export {
  buildWorktreeCandidatePlan,
  canonicalWorktreePath,
  slugifyTaskTitle,
  type WorktreeCandidatePlan,
  type WorktreeSetupCandidate,
} from './setupCandidates.js';
export {
  resolveRepoRootAndPrepareProject,
  type PreparedProject,
} from './setupProject.js';

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
