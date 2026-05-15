import path from 'node:path';
import fs from 'node:fs/promises';
import { projectGit } from '../projectGit.js';

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
export const LATTICE_REPO_EXCLUDE_ENTRIES = ['.lattice/', 'node_modules/'] as const;

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
