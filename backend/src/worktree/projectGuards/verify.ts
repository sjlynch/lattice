import { projectGit } from '../projectGit.js';

// Probe whether the essentials Lattice depends on (`.lattice/`,
// `node_modules/`) are excluded from git — by `.gitignore`, `.git/info/exclude`,
// or any other source. Uses `git check-ignore` so we don't have to parse the
// rules ourselves and we honor the same precedence git would.
//
// Why this matters: the working-tree snapshot (snapshot.ts) enumerates
// untracked files via `git status` and copies-then-deletes them so the
// fast-forward sees a clean tree. If `.lattice/` is not excluded, that
// would scoop up live workflow/run state from `<repo>/.lattice/`. Same
// hazard for `node_modules/`. (Pre-2026-05-10 this was even worse — the
// snapshot's predecessor, `git stash --include-untracked`, would also
// pull in the nested worktree checkouts that used to live under
// `.lattice/`, and a lost stash deleted the lot. Worktrees now live
// outside the project, but the exclusion still matters for the rest.)
//
// We probe synthetic paths so the result doesn't depend on which files
// happen to exist right now.
export async function verifyEssentialExclusions(
  repoRoot: string,
): Promise<{ ok: boolean; missing: string[] }> {
  const repoCheck = await projectGit(repoRoot, ['rev-parse', '--show-toplevel']);
  if (repoCheck.code !== 0) {
    return { ok: false, missing: ['<not a git repository>'] };
  }
  const probes = ['.lattice/probe', 'node_modules/probe'];
  const missing: string[] = [];
  for (const p of probes) {
    const r = await projectGit(repoRoot, ['check-ignore', '--quiet', p]);
    // Exit 0 = path is ignored, 1 = not ignored, 128 = error. Treat anything
    // non-zero as "not properly excluded" so we err on the side of caution.
    if (r.code !== 0) missing.push(p);
  }
  return { ok: missing.length === 0, missing };
}
