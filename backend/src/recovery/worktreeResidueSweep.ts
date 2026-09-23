// Reclaim dependency residue left under `~/.lattice/worktrees/<hash>/` by a
// `git worktree remove --force` that failed part-way.
//
// On Windows git cannot delete a hard link to an executable image that is
// running — and pnpm hard-links `esbuild.exe` / `rollup.*.node` from its store
// into every checkout's node_modules, so any vite/esbuild process anywhere on
// the machine pins those files in EVERY worktree. `git worktree remove` then
// deletes everything else, reports failure, and — this is git's documented
// behaviour — still deletes the worktree's registration. The directory is now
// invisible to `git worktree list`, so neither `cleanupWorktreeForTask` (which
// preserves unregistered directories) nor `sweepOrphanedWorktrees` (which walks
// registrations) ever looks at it again: 573 such directories piled up for
// one project by 2026-09-22.
//
// Deliberately narrow — the only thing removed is a direct child of the
// project's home worktrees dir that
//   - git has no registration for,
//   - no in_progress / ready_to_merge / queued task records as its worktree,
//   - no live pty sits in,
//   - is not a reparse point and has no `.git` marker,
//   - contains nothing but `node_modules`, and
//   - has not been touched for RESIDUE_MIN_AGE_MS.
// i.e. it cannot hold anyone's work. Removal is guarded like every other
// scratch delete (reparse-point check + internal junction pruning first). A
// file that is still locked just leaves the residue for the next boot.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '../tasks.js';
import { homeWorktreesDir } from '../projectPath.js';
import { parseWorktreesPorcelain } from '../worktree/state.js';
import { assertNotReparsePoint } from '../worktree/cleanupSafety.js';
import { pruneReparsePointsUnder } from '../worktree/reparsePoints.js';
import { isPathStrictlyInside } from '../worktree/paths.js';
import { hasLiveSessionAtOrUnder, normalizeCwd } from './liveSessions.js';
import type { projectGit as ProjectGit } from '../worktree/projectGit.js';

const RESIDUE_MIN_AGE_MS = 10 * 60_000;
const RESIDUE_ONLY_ENTRIES = new Set(['node_modules']);
const ACTIVE_STATUSES = new Set(['in_progress', 'ready_to_merge']);

export type ResidueSweepDeps = {
  projectGit: typeof ProjectGit;
  removeDir: (dir: string) => Promise<boolean>;
  now: () => number;
  worktreesDir: (repoRoot: string) => string;
};

// One guarded attempt, no retries and no per-dir log: a lock (the common
// case — see above) fails the same way for hundreds of dirs, and retrying or
// logging each would stall/flood boot. The summary line below reports them.
async function removeResidueDir(dir: string): Promise<boolean> {
  try {
    await assertNotReparsePoint(dir);
    await pruneReparsePointsUnder(dir);
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const defaultDeps = (projectGit: typeof ProjectGit): ResidueSweepDeps => ({
  projectGit,
  removeDir: removeResidueDir,
  now: () => Date.now(),
  worktreesDir: homeWorktreesDir,
});

export async function sweepWorktreeResidue(
  repoRoot: string,
  tasks: Task[],
  liveCwds: Set<string>,
  projectGit: typeof ProjectGit,
  deps: ResidueSweepDeps = defaultDeps(projectGit),
): Promise<number> {
  const base = deps.worktreesDir(repoRoot);
  let names: string[];
  try {
    names = await fs.readdir(base);
  } catch {
    return 0; // no worktrees dir for this project
  }
  const listed = await deps.projectGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  if (listed.code !== 0) return 0; // can't prove anything is unregistered
  const registered = new Set(parseWorktreesPorcelain(listed.stdout).map((wt) => normalizeCwd(wt.path)));
  const owned = new Set(
    tasks
      .filter((t) => (ACTIVE_STATUSES.has(t.status) || t.runQueued) && t.worktreePath)
      .map((t) => normalizeCwd(t.worktreePath as string)),
  );

  let removed = 0;
  let lockedCount = 0;
  for (const name of names) {
    const dir = path.join(base, name);
    // Belt-and-braces: only ever a direct child of the home worktrees dir,
    // which lives outside every project tree.
    if (!isPathStrictlyInside(base, dir) || path.dirname(path.resolve(dir)) !== path.resolve(base)) continue;
    const key = normalizeCwd(dir);
    if (registered.has(key) || owned.has(key) || hasLiveSessionAtOrUnder(liveCwds, dir)) continue;
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (deps.now() - st.mtimeMs < RESIDUE_MIN_AGE_MS) continue;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    // Empty dirs qualify too; anything else (a `.git` file, source, …) does not.
    if (!entries.every((e) => RESIDUE_ONLY_ENTRIES.has(e))) continue;
    if (await deps.removeDir(dir)) {
      removed += 1;
    } else {
      lockedCount += 1;
    }
  }
  if (removed > 0) {
    console.log(`[startup] residue sweep: removed ${removed} leftover dependency-only worktree dir(s) under ${base}`);
  }
  if (lockedCount > 0) {
    console.warn(
      `[startup] residue sweep: ${lockedCount} leftover dir(s) under ${base} are still locked ` +
        '(usually a running esbuild/vite holding pnpm hard links) — retrying next boot',
    );
  }
  return removed;
}
