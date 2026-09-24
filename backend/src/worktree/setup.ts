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
import { recordWorktreeCheckoutSize, reserveWorktreeDiskSpace } from './diskSpace.js';
import { withCheckoutSlot } from './checkoutGate.js';
import { lfsCheckoutEnv, taskWorktreeLfsMode } from './lfsMode.js';
import { lfsPointerNoteFor } from './lfsPaths.js';
import { getDeadCodeSummarySafe } from '../deadCode.js';

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
  // Git LFS files as pointer stubs (the default) or full content — lfsMode.ts.
  // The same mode sizes the disk reservation and is what the size observation
  // is recorded under.
  const lfsMode = await taskWorktreeLfsMode(repoPath);

  // Heavy checkouts run two at a time (checkoutGate.ts). Inside the gate, the
  // disk guard throws SpawnDiskSpaceError (a spawn-queue deferral, not a
  // failure) when the checkout would push the disk below the free-space
  // reserve — checked there so setups waiting on the gate hold no reservation.
  const candidate = await withCheckoutSlot(async () => {
    const disk = await reserveWorktreeDiskSpace(repoRoot, plan.worktreesDir, undefined, { lfsMode });
    try {
      return await addWorktreeWithRetries(repoRoot, plan, task.title, lfsCheckoutEnv(lfsMode));
    } finally {
      disk.release();
    }
  });
  void recordWorktreeCheckoutSize(repoRoot, candidate.candidatePath, lfsMode);
  // Dead-code summary is derived from the *main checkout* (warm health cache),
  // not the fresh worktree. Best-effort + time-bounded so a slow scan never
  // blocks worktree creation; a null result just omits the note.
  const deadCode = await getDeadCodeSummarySafe(repoRoot);
  // Pointer mode on a repo with LFS files: tell the agent how to get a real one.
  const lfsNote = await lfsPointerNoteFor(repoRoot, lfsMode);
  const taskFile = await writePostAddWorktreeFiles(
    candidate.candidatePath,
    task,
    backendOrigin,
    harness,
    [...envNotes, ...(lfsNote ? [lfsNote] : [])],
    deadCode,
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
  renderStopHookJson,
} from './stopHook.js';
