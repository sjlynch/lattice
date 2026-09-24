// Git LFS content in task worktrees (`UserSettings.taskWorktreeLfsContent`).
//
// A task worktree is a full checkout, and on an LFS-heavy repo most of it is
// binary assets: 7.4 GB per worktree of which 4.8 GB was LFS content (1083
// .fbx/.blend/.glb files), so 22 Ready-to-Merge worktrees filled a disk
// (2026-09-23). Task agents edit code and run no tests or builds, so by default
// ('pointers') every git process that checks files out INTO a task worktree
// runs with `GIT_LFS_SKIP_SMUDGE=1`: LFS files land as ~130-byte pointer stubs.
// That is `git worktree add` (setupAdd.ts, the merge preflight's re-create),
// the worktree-side `git merge` of main (merge/runWorktreeMerge.ts) and its
// `merge --abort` (state.ts), and the agent's own pty (the spawn chokepoint,
// terminalServerClient/createSession.ts). A pointer stub is exactly what LFS's
// clean filter produces for that file, so `git status` stays clean and a
// commit/merge carries the pointer through unchanged; main's fast-forward runs
// with the normal env and smudges real content from the local LFS store.
//
// The merge-side env is decided by the setting at MERGE time, not recorded per
// worktree: a worktree created in 'full' mode and merged after the user flipped
// to 'pointers' just gets pointers for the few LFS files main changed (and the
// reverse smudges those few) — harmless either way.
//
// Kept free of projectGit so state.ts (merge --abort) can import it without a
// cycle; the LFS path listing + brief note live in lfsPaths.ts.

import path from 'node:path';
import { exec } from './exec.js';
import { getTaskWorktreeLfsContent } from '../userSettings.js';

export type LfsCheckoutMode = 'pointers' | 'full';

// The project's mode; a settings read failure falls back to the default.
export async function taskWorktreeLfsMode(projectPath: string): Promise<LfsCheckoutMode> {
  try {
    return await getTaskWorktreeLfsContent(projectPath);
  } catch {
    return 'pointers';
  }
}

// Env for a git process that checks files out into a task worktree, or
// undefined (inherit) in 'full' mode.
export function lfsCheckoutEnv(mode: LfsCheckoutMode): Record<string, string> | undefined {
  return mode === 'pointers' ? { GIT_LFS_SKIP_SMUDGE: '1' } : undefined;
}

export async function taskWorktreeCheckoutEnv(
  projectPath: string,
): Promise<Record<string, string> | undefined> {
  return lfsCheckoutEnv(await taskWorktreeLfsMode(projectPath));
}

// The same env, for a git run inside an EXISTING worktree that only knows its
// own path: the project is the parent of the worktree's common git dir. An
// unresolvable project reads as the default mode.
export async function worktreeCheckoutEnv(
  worktreePath: string,
): Promise<Record<string, string> | undefined> {
  try {
    const r = await exec('git', ['rev-parse', '--git-common-dir'], worktreePath, {
      timeoutMs: 10_000,
    });
    const common = r.code === 0 ? r.stdout.trim() : '';
    if (!common) return lfsCheckoutEnv('pointers');
    return await taskWorktreeCheckoutEnv(path.dirname(path.resolve(worktreePath, common)));
  } catch {
    return lfsCheckoutEnv('pointers');
  }
}
