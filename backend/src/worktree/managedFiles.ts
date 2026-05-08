// Single source of truth for files Lattice writes/owns inside a worktree
// or repo root. Three concerns are colocated here so adding a new
// Lattice-managed file means editing exactly one place:
//
//   - exclude patterns: written into the worktree's .git/info/exclude so
//     `git status` ignores them and Claude's `git add -A` won't stage them.
//   - shelve patterns: files moved aside before `git merge` because git
//     errors with "untracked file would be overwritten by merge" if a
//     prior resolver Claude accidentally committed them on main.
//   - auto-resolve set: files Lattice owns whose merge/stash-pop
//     conflicts always resolve to "ours" (the worktree's current version).
//     `.claude/settings.local.json` is the load-bearing case — its task-id
//     URL is per-worktree, so the worktree's own version is always the
//     correct Stop-hook target. Resolving via Claude is impossible because
//     conflict markers in the JSON break Claude's bootstrap.

// Repo-relative file paths Lattice writes that should never be tracked.
// Added to .gitignore (repo root) and .git/info/exclude (per worktree).
export const LATTICE_OWNED_FILE_PATHS = [
  'LATTICE_TASK.md',
  'MERGE_INSTRUCTIONS.md',
  '.claude/settings.local.json',
] as const;

// Patterns for the worktree-local exclude file. STASH_CONFLICT_*.md is a
// glob (one per task plus a `_run.md` for run-level stashes), so a
// pattern is needed rather than an exact path.
export const LATTICE_EXCLUDE_PATTERNS = [
  'LATTICE_TASK.md',
  'MERGE_INSTRUCTIONS.md',
  'STASH_CONFLICT_*.md',
  '.claude/settings.local.json',
] as const;

// .gitignore entries appended to the project's repo-root .gitignore.
// `.lattice/` would also belong here but is left to the project to
// declare — it's the Lattice scratch area and projects may want it
// committed (e.g. if they hand-author tasks.json). The settings file is
// the only entry Lattice insists on.
export const LATTICE_GITIGNORE_ENTRIES = [
  '.claude/settings.local.json',
] as const;

// Conflict paths that always resolve to "ours" (the worktree's version).
// Includes the STASH_CONFLICT_*.md glob — those are run/task-scoped and
// the live one always supersedes whatever was on disk before.
export function isLatticeOwnedConflictPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  if ((LATTICE_OWNED_FILE_PATHS as readonly string[]).includes(norm)) return true;
  if (/^STASH_CONFLICT_[A-Za-z0-9_-]+\.md$/.test(norm)) return true;
  return false;
}
