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
//     `.pi/extensions/lattice-complete.ts` is the Pi-harness analogue —
//     same per-worktree task-id URL, same "ours always wins" logic.
//     `.pi/extensions/lattice-subagents.ts` is the pi-subagents loader shim
//     (see piSubagents.ts) — Lattice-owned, identical content everywhere.

// Repo-relative file paths Lattice writes that should never be tracked.
// Added to .gitignore (repo root) and .git/info/exclude (per worktree).
//
// `.pi/extensions/lattice-complete.ts` is written into Pi-capable worktrees
// (Pi's analogue of the Claude Stop hook — see installPiCompletionExtension in
// stopHook.ts); `.pi/extensions/lattice-subagents.ts` is the pi-subagents
// loader shim (see piSubagents.ts) Lattice drops alongside it (and at the
// project root for manual terminal-panel `pi` sessions);
// `.pi/extensions/lattice-mcp.ts` is the pi-mcp-adapter loader shim and
// `.pi/mcp.json` its per-cwd server config (see piMcp.ts), both dropped only
// when the project enables ≥1 Pi MCP server. The exact paths (not the whole
// `.pi/` dir) are listed so a project that legitimately tracks its own `.pi/`
// settings isn't disturbed.
export const LATTICE_OWNED_FILE_PATHS = [
  'LATTICE_TASK.md',
  'MERGE_INSTRUCTIONS.md',
  '.claude/settings.local.json',
  '.pi/extensions/lattice-complete.ts',
  '.pi/extensions/lattice-subagents.ts',
  '.pi/extensions/lattice-mcp.ts',
  '.pi/extensions/lattice-system-prompt.ts',
  '.pi/extensions/lattice-system-prompt.json',
  '.pi/mcp.json',
] as const;

// Patterns for the worktree-local exclude file. STASH_CONFLICT_*.md is a
// glob (one per task plus a `_run.md` for run-level stashes), so a
// pattern is needed rather than an exact path.
//
// `.pi/extensions/lattice-last-shutdown.json` is the sentinel audit log
// written by the hardened Pi completion extension (see piExtension.ts) —
// regenerated on each Pi session_shutdown, never tracked.
//
// `.codex/hooks.json` is the Codex Stop-hook backstop (Codex's analogue of the
// Claude Stop hook / Pi completion extension — see codexStopHook.ts). It is
// installed into a task worktree only when the repo doesn't already track one
// (the `if-absent` policy), and it is NOT in the owned/auto-resolve set on
// purpose: since it might be the repo's own file, resolving a merge conflict on
// it to "ours" could silently drop the user's changes. Excluding it here just
// hides Lattice's untracked copy from `git status` (a no-op for a tracked file).
export const LATTICE_EXCLUDE_PATTERNS = [
  'LATTICE_TASK.md',
  'MERGE_INSTRUCTIONS.md',
  'STASH_CONFLICT_*.md',
  '.claude/settings.local.json',
  '.pi/extensions/lattice-complete.ts',
  '.pi/extensions/lattice-last-shutdown.json',
  '.pi/extensions/lattice-subagents.ts',
  '.pi/extensions/lattice-mcp.ts',
  '.pi/extensions/lattice-system-prompt.ts',
  '.pi/extensions/lattice-system-prompt.json',
  '.pi/mcp.json',
  '.codex/hooks.json',
] as const;

// .gitignore entries appended to the project's repo-root .gitignore.
// `.lattice/` is mandatory — its `worktrees/` subdirectory contains
// nested git checkouts (each with a `.git` pointer file). If `.lattice/`
// is left untracked-but-not-ignored, `git stash push --include-untracked`
// (used by the per-task fast-forward) tries to stash the worktree
// directories and aborts with `error: invalid path
// '.lattice/worktrees/<id>/'` — breaking every merge in the run.
export const LATTICE_GITIGNORE_ENTRIES = [
  '.claude/settings.local.json',
  '.lattice/',
  '.pi/extensions/lattice-complete.ts',
  '.pi/extensions/lattice-last-shutdown.json',
  '.pi/extensions/lattice-subagents.ts',
  '.pi/extensions/lattice-mcp.ts',
  '.pi/extensions/lattice-system-prompt.ts',
  '.pi/extensions/lattice-system-prompt.json',
  '.pi/mcp.json',
] as const;

// Paths shelved (moved aside) for the duration of a worktree `git merge`.
//
// Every one of these is a file Lattice writes into a worktree WITHOUT tracking
// it. The moment any of them gets committed on `main` — a resolver Claude that
// ran `git add -A`, a codex agent committing its own `.codex/`, a worktree
// created before the exclude patterns covered the path — `git merge main` into
// every OTHER worktree aborts with:
//
//   error: The following untracked working tree files would be overwritten by
//   merge: <path> ... Aborting
//
// which errors that task out of the merge run with nothing a resolver agent can
// fix (the merge never starts, so there is no conflict to resolve). Observed on
// 2026-08-24: `.codex/hooks.json` became tracked on main and errored two tasks
// of a ten-task run. The shelve list used to be a hardcoded two-entry array in
// mergeOwnedFiles.ts, so every Lattice-managed file added since (the `.pi/*`
// shims, `.codex/hooks.json`) was unprotected — hence deriving it here, next to
// the lists it must stay in sync with.
//
// Shelving is UNTRACKED-ONLY (see mergeOwnedFiles.ts): a path the worktree
// tracks is left alone so the ordinary conflict / auto-resolve path handles it.
export const LATTICE_SHELVE_PATHS = [
  ...LATTICE_OWNED_FILE_PATHS,
  // Not Lattice-owned (it may be the repo's own file — see the note above on
  // the `if-absent` install policy), but Lattice's untracked copy blocks a
  // merge exactly the same way, so it is shelved and then restored only if the
  // merge didn't make it tracked.
  '.codex/hooks.json',
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
