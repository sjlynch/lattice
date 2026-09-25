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

// The absolute-path guard every project-scoped route runs before
// `canonicalProjectPath`. `path.isAbsolute` is not enough on Windows: it accepts
// a ROOT-relative path (`\foo`, or the MSYS/Git-Bash spelling
// `/c/development/lattice`), which `path.resolve` then pins to the backend's
// current drive (`C:\c\development\lattice`) — a phantom project that reads as
// a silently-empty board. On win32 only a drive-absolute (`C:\…`, `C:/…`) or
// UNC (`\\server\share\…`, incl. `\\?\C:\…`) path names a real place. POSIX is
// unchanged. `platform` is a test seam.
export function isRealAbsoluteProjectPath(
  input: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return path.posix.isAbsolute(input);
  return /^[A-Za-z]:[\\/]/.test(input) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]/.test(input);
}

// For a path `isRealAbsoluteProjectPath` refused on win32: the `C:\…` spelling
// an MSYS / Git-Bash path (`/c/development/lattice`) most likely meant, or
// `null` when it isn't one. Forward slashes only: `\x` is root-relative, not a
// drive letter.
export function msysToWindowsPath(input: string): string | null {
  const m = /^\/([A-Za-z])(?:\/(.*))?$/.exec(input);
  if (!m) return null;
  return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
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
