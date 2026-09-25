import { exec } from './exec.js';
import { resolveEnvNotesForInstructions } from './envDetect.js';
import {
  ensureLatticeRepoExclude,
  untrackOwnedFilesInRepo,
} from './projectGuards.js';

export type PreparedProject = {
  repoRoot: string;
  envNotes: string[];
};

export async function resolveRepoRootAndPrepareProject(
  repoPath: string,
): Promise<PreparedProject> {
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
  // projects self-heal on first task run. Only the repo-local, UNTRACKED
  // `.git/info/exclude` is written — it is shared by the main checkout and
  // every worktree and covers the full managed set. This used to append to
  // the tracked `.gitignore` too, which left an uncommitted `.gitignore` edit
  // on main whenever the managed list grew (on Lattice's own repo: after any
  // merge that added an entry) — dirtying the checkout merges fast-forward
  // and colliding with a task that edits `.gitignore`. `git init` of a new
  // project still writes its starter `.gitignore` (it gets committed).
  await ensureLatticeRepoExclude(repoRoot);
  await untrackOwnedFilesInRepo(repoRoot);
  // Env-specific "you're in a throwaway worktree, don't reinstall deps
  // unless this task needs it" notes — computed once (project-derived, not
  // per-candidate-path) and prepended to LATTICE_TASK.md. See envDetect.ts.
  const envNotes = await resolveEnvNotesForInstructions(repoRoot);

  return { repoRoot, envNotes };
}
