import path from 'node:path';
import fs from 'node:fs/promises';
import { projectGit } from './projectGit.js';
import { assertGitDirIntact } from './state.js';
import {
  LATTICE_GITIGNORE_ENTRIES,
  LATTICE_OWNED_FILE_PATHS,
} from './managedFiles.js';

// Append `.claude/settings.local.json` to the repo's root .gitignore if
// it isn't already covered. Idempotent: scans the existing file for
// either the literal entry or any line that would match it via gitignore
// pattern semantics. Bails silently if the project has no .gitignore
// (creating one would surprise the user); the worktree-local exclude
// still protects merges in that case.
export const LATTICE_GITIGNORE_MARKER = '# lattice-managed (do not remove)';

export async function ensureLatticeGitignore(repoRoot: string): Promise<void> {
  const ignoreFile = path.join(repoRoot, '.gitignore');
  let existing: string;
  try {
    existing = await fs.readFile(ignoreFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.warn('[worktree] could not read .gitignore:', err);
    return;
  }
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const missing = LATTICE_GITIGNORE_ENTRIES.filter(
    (entry) => !lines.some((l) => l === entry || l === `/${entry}`),
  );
  if (missing.length === 0) return;
  const trailingNewline = existing.endsWith('\n') ? '' : '\n';
  const block =
    `${trailingNewline}\n${LATTICE_GITIGNORE_MARKER}\n${missing.join('\n')}\n`;
  try {
    await fs.appendFile(ignoreFile, block, 'utf8');
    console.log(
      `[worktree] appended ${missing.length} entry(ies) to ${ignoreFile}`,
    );
  } catch (err) {
    console.warn('[worktree] could not append to .gitignore:', err);
  }
}

// Add `.lattice/` to the repo-local `.git/info/exclude` so git treats the
// scratch directory as ignored *immediately and unconditionally*, even
// when the project's tracked `.gitignore` doesn't (yet) list it.
//
// `<repo>/.lattice/` no longer holds the worktree checkouts (those moved
// to `~/.lattice/worktrees/<hash>/`), but it still holds workflow-steps/,
// workflows.json, userSettings.json, health-cache.json — live state that
// must never be committed and must never be swept into a working-tree
// snapshot. `.git/info/exclude` lives inside the gitdir, is never tracked,
// and is never touched by snapshots/stash, so `.lattice/` stays ignored
// regardless of the tracked `.gitignore` state.
//
// Idempotent. Bails silently if the gitdir can't be located (worktree
// without a parent, exotic git layout) — the .gitignore path still
// applies in that case.
export const LATTICE_REPO_EXCLUDE_MARKER = '# lattice-managed (do not remove)';
export const LATTICE_REPO_EXCLUDE_ENTRIES = ['.lattice/'] as const;

export async function ensureLatticeRepoExclude(repoRoot: string): Promise<void> {
  // `--git-common-dir` resolves to the main repo's gitdir even when
  // `repoRoot` is a worktree (which has its own per-worktree gitdir). We
  // want the COMMON gitdir because the exclude file there governs every
  // worktree of the repo.
  const r = await projectGit(repoRoot, ['rev-parse', '--git-common-dir']);
  if (r.code !== 0 || !r.stdout.trim()) return;
  const gitDir = path.resolve(repoRoot, r.stdout.trim());
  const infoDir = path.join(gitDir, 'info');
  const excludeFile = path.join(infoDir, 'exclude');
  let existing = '';
  try {
    existing = await fs.readFile(excludeFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[worktree] could not read .git/info/exclude:', err);
      return;
    }
    // ENOENT — fine; the file is created by appendFile below.
  }
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const missing = LATTICE_REPO_EXCLUDE_ENTRIES.filter(
    (entry) => !lines.some((l) => l === entry || l === `/${entry}`),
  );
  if (missing.length === 0) return;
  const trailingNewline = existing && !existing.endsWith('\n') ? '\n' : '';
  const block =
    `${trailingNewline}\n${LATTICE_REPO_EXCLUDE_MARKER}\n${missing.join('\n')}\n`;
  try {
    await fs.mkdir(infoDir, { recursive: true });
    await fs.appendFile(excludeFile, block, 'utf8');
    console.log(
      `[worktree] appended ${missing.length} entry(ies) to ${excludeFile}`,
    );
  } catch (err) {
    console.warn('[worktree] could not append to .git/info/exclude:', err);
  }
}

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

// `git rm --cached` any Lattice-owned file that's still tracked in `repoRoot`,
// then commit the cleanup so it propagates when branches merge. Files stay
// on disk (rm --cached only touches the index). Idempotent: skips files
// that aren't tracked, and skips the commit if the index is unchanged.
//
// Called at:
//   - setupTaskWorktree (per-worktree create) — heals projects on first use
//   - startMergeRun (pre-flight)              — heals before main absorbs branches
//   - /api/tasks/:id/merge (manual merge)     — heals before a one-off merge
//
// Aborts (no-op) if the working tree has uncommitted changes — a commit
// here would entangle Lattice's cleanup with whatever the user is editing.
// The auto-resolve path at merge time still handles the conflict case.
export async function untrackOwnedFilesInRepo(repoRoot: string): Promise<void> {
  // Bail before any git work if .git is missing. Other callers in the
  // merge pipeline already guard at their level, but this function is
  // also called directly from /merge and the run pre-flight, so we guard
  // here too.
  await assertGitDirIntact(repoRoot);
  const tracked: string[] = [];
  for (const f of LATTICE_OWNED_FILE_PATHS) {
    const ls = await projectGit(repoRoot, ['ls-files', '--error-unmatch', f]);
    if (ls.code === 0 && ls.stdout.trim()) tracked.push(f);
  }
  if (tracked.length === 0) return;

  const status = await projectGit(repoRoot, ['status', '--porcelain']);
  if (status.code !== 0) {
    console.warn(`[worktree] untrack: git status failed in ${repoRoot}`);
    return;
  }
  // Tolerate the working tree containing only Lattice-owned files (e.g. a
  // freshly-installed Stop hook). Anything else means real user state we
  // shouldn't bundle into a Lattice-auto commit.
  const dirtyOther = status.stdout
    .split(/\r?\n/)
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .filter((p) => !(LATTICE_OWNED_FILE_PATHS as readonly string[]).includes(p));
  if (dirtyOther.length > 0) {
    console.log(
      `[worktree] skipping untrack of [${tracked.join(', ')}] in ${repoRoot} ` +
        `— working tree has unrelated changes (${dirtyOther.slice(0, 3).join(', ')}${dirtyOther.length > 3 ? ', …' : ''})`,
    );
    return;
  }

  const rm = await projectGit(repoRoot, ['rm', '--cached', '--quiet', ...tracked]);
  if (rm.code !== 0) {
    console.warn(
      `[worktree] git rm --cached failed in ${repoRoot}: ${rm.stderr.trim()}`,
    );
    return;
  }
  const commit = await projectGit(repoRoot, [
    'commit',
    '-m',
    `Untrack Lattice-managed files [lattice-auto]\n\n${tracked.map((f) => `- ${f}`).join('\n')}`,
  ]);
  if (commit.code !== 0) {
    // No commit usually means the index ended up unchanged (race with
    // another process). Reset the index to keep state coherent.
    console.warn(
      `[worktree] commit after rm --cached failed: ${commit.stderr.trim() || commit.stdout.trim()}`,
    );
    await projectGit(repoRoot, ['reset', 'HEAD', '--', ...tracked]);
    return;
  }
  console.log(
    `[worktree] untracked Lattice-owned file(s) from ${repoRoot}: ${tracked.join(', ')}`,
  );
}
