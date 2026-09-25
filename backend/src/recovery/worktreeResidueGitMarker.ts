// `.git` marker classification for the worktree residue sweep
// (`worktreeResidueSweep.ts`): does a leftover dir under
// `~/.lattice/worktrees/<hash>/` carry a `.git` that makes it not ours to
// delete? Read-only — nothing here mutates the filesystem.

import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeCwd } from './liveSessions.js';
import type { projectGit as ProjectGit } from '../worktree/projectGit.js';

const COMMON_DIR_GIT_TIMEOUT_MS = 15_000;

// A git worktree `.git` file is one short `gitdir: <path>` line.
export const GIT_FILE_MAX_BYTES = 4096;

export async function commonGitDirVia(projectGit: typeof ProjectGit, repoRoot: string): Promise<string | null> {
  const r = await projectGit(repoRoot, ['rev-parse', '--git-common-dir'], { timeoutMs: COMMON_DIR_GIT_TIMEOUT_MS });
  const dir = r.code === 0 ? r.stdout.trim() : '';
  return dir ? path.resolve(repoRoot, dir) : null;
}

// Not the same as `worktree/reconcile.ts`'s `entryExists` (which rethrows non-ENOENT errors) — do not merge them.
export async function entryExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (err) {
    // Anything but ENOENT is unknown state — treat it as present (keep the dir).
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    const st = await fs.lstat(target);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function isRegularFile(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isFile();
  } catch {
    return false;
  }
}

// What a dir's `.git` marker says about deleting it:
//   'none'     — no marker at all;
//   'orphaned' — a `.git` FILE whose `gitdir:` names `<commonDir>/worktrees/<id>`
//                of this repo, that admin dir is gone, and the common dir is
//                intact (a `git worktree remove` that died after dropping the
//                admin dir but before reaching `.git`);
//   'keep'     — anything else: a `.git` dir (another repo / a real checkout),
//                a pointer elsewhere, a live admin dir, or any unknown state.
export type GitMarker = 'none' | 'orphaned' | 'keep';

export async function classifyGitMarker(
  dir: string,
  entries: string[],
  commonDir: () => Promise<string | null>,
): Promise<GitMarker> {
  // Case-folded: `.GIT` on a case-sensitive filesystem is still not ours to judge.
  const names = entries.filter((e) => e.toLowerCase() === '.git');
  if (names.length === 0) return (await entryExists(path.join(dir, '.git'))) ? 'keep' : 'none';
  if (names.length > 1) return 'keep';
  const marker = path.join(dir, names[0]);
  let text: string;
  try {
    const st = await fs.lstat(marker);
    if (!st.isFile() || st.size > GIT_FILE_MAX_BYTES) return 'keep';
    text = await fs.readFile(marker, 'utf8');
  } catch {
    return 'keep';
  }
  const m = /^gitdir:[ \t]*(.+?)[ \t]*$/.exec(text.split(/\r?\n/, 1)[0] ?? '');
  if (!m) return 'keep';
  const common = await commonDir();
  if (!common) return 'keep';
  // A vanished/damaged `.git` would make EVERY admin dir read as missing.
  if (!(await isDirectory(common)) || !(await isRegularFile(path.join(common, 'HEAD')))) return 'keep';
  const adminDir = path.resolve(dir, m[1]);
  if (normalizeCwd(path.dirname(adminDir)) !== normalizeCwd(path.join(common, 'worktrees'))) return 'keep';
  // entryExists reads anything but ENOENT as present — unknown state keeps the dir.
  return (await entryExists(adminDir)) ? 'keep' : 'orphaned';
}
