// Project path facade. Existing directories use native realpath identity so
// Windows case aliases and junctions share caches, workflow state, and locks.
// projectIdentity.ts preserves legacy storage hashes through durable bindings;
// changing canonical spelling must never hide existing tasks or snapshots.

import path from 'node:path';
import os from 'node:os';
import { physicalProjectPath, projectStorageHash } from './projectIdentity.js';

export function canonicalProjectPath(input: string): string {
  return physicalProjectPath(input);
}

// Stable per-project key for use as a directory name in shared global
// state (`~/.lattice/per-project/<hash>/`, `~/.lattice/snapshots/<hash>/`,
// `~/.lattice/worktrees/<hash>/`, `~/.lattice/git-backups/<hash>/`).
// SHA-1 of the physical path, or its preserved legacy storage binding,
// truncated to 12 hex chars — collision risk
// is negligible for the tens-to-hundreds of projects a single user has.
// Always use this rather than rolling your own; otherwise two consumers
// can disagree on which directory belongs to which project.
export function projectHash(projectPath: string): string {
  return projectStorageHash(projectPath);
}

export function latticeHomeDir(): string {
  return path.join(os.homedir(), '.lattice');
}

// Per-session terminal scrollback logs: `~/.lattice/terminal-scrollback/`.
// Home-scoped (never inside a project tree) and wiped on terminal-server boot,
// since a restart invalidates every in-memory session anyway.
export function terminalScrollbackDir(): string {
  return path.join(latticeHomeDir(), 'terminal-scrollback');
}

// Shared per-project home state/scratch root:
// `~/.lattice/per-project/<projectHash>/`. Use this for project-scoped data
// that must survive project-tree damage and must not be recursively deleted
// from inside the repo.
export function homeProjectDir(projectPath: string): string {
  return path.join(latticeHomeDir(), 'per-project', projectHash(projectPath));
}

export function homeProjectScratchDir(
  projectPath: string,
  ...segments: string[]
): string {
  return path.join(homeProjectDir(projectPath), ...segments);
}

// Where Lattice puts the per-task worktree checkouts for a given project:
// `~/.lattice/worktrees/<projectHash>/`. Deliberately OUTSIDE the project
// tree — see the comment on `homeWorktreesDir`'s usage in worktree/setup.ts
// for why (it's the headline fix for the recurring `.git` deletions).
export function homeWorktreesDir(repoRoot: string): string {
  return path.join(latticeHomeDir(), 'worktrees', projectHash(repoRoot));
}
