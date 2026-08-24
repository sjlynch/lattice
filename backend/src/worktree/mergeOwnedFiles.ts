// Owned-file hygiene around a worktree `git merge`: shelve the untracked
// Lattice-managed files for the duration of the merge, restore them after,
// and untrack any owned file the merge dragged in from a prior accidental
// commit. The merge flow itself lives in merge.ts.

import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from './exec.js';
import {
  LATTICE_OWNED_FILE_PATHS,
  LATTICE_SHELVE_PATHS,
} from './managedFiles.js';

// Is `file` tracked in this worktree's index?
async function isTracked(worktreePath: string, file: string): Promise<boolean> {
  const res = await exec('git', ['ls-files', '--', file], worktreePath);
  return res.stdout.trim().length > 0;
}

// Move Lattice's UNTRACKED copies of its managed files aside so `git merge`
// doesn't abort with "untracked working tree files would be overwritten by
// merge" when main happens to track one of them. Returns the shelved paths.
//
// Two properties are load-bearing:
//
//   - The list comes from LATTICE_SHELVE_PATHS (managedFiles.ts), not a local
//     array. The local array had only LATTICE_TASK.md + MERGE_INSTRUCTIONS.md
//     and silently failed to cover every managed file added since — a merge run
//     erroring on `.codex/hooks.json` is what surfaced it.
//   - Only UNTRACKED files are shelved. Renaming a TRACKED file aside would
//     read as a local deletion and make git refuse the merge for a different
//     reason ("Your local changes would be overwritten"); tracked owned files
//     are handled by resetOwnedFileLocalChanges + the owned-file conflict
//     auto-resolve instead. This is also why `.claude/settings.local.json` is
//     safe to include now: the untracked case (which used to abort the merge)
//     is shelved, and the tracked case still goes down the auto-resolve path.
export async function shelveLatticeManagedFiles(worktreePath: string): Promise<string[]> {
  const shelved: string[] = [];
  for (const f of LATTICE_SHELVE_PATHS) {
    const src = path.join(worktreePath, f);
    try {
      await fs.access(src);
    } catch {
      continue; // file absent — nothing to move
    }
    try {
      if (await isTracked(worktreePath, f)) continue;
      await fs.rename(src, `${src}.lattice-bak`);
      shelved.push(f);
    } catch {
      /* best-effort: a failure here just leaves the pre-existing behaviour */
    }
  }
  return shelved;
}

const OWNED_PATHS = new Set<string>(LATTICE_OWNED_FILE_PATHS);

// Put the shelved copies back. A Lattice-OWNED file always wins (its content is
// per-worktree — task id, Stop-hook callback URL — and untrackOwnedFilesPostMerge
// de-indexes whatever the merge dragged in). A shelved path Lattice does NOT own
// (`.codex/hooks.json`, which may legitimately be the repo's own file) is
// restored only while it is still untracked: if the merge materialized a tracked
// version, that is the user's file and Lattice's copy is dropped rather than
// silently overwriting it with a dirty working-tree change.
export async function restoreLatticeManagedFiles(worktreePath: string, files: string[]): Promise<void> {
  for (const f of files) {
    const dest = path.join(worktreePath, f);
    const bak = `${dest}.lattice-bak`;
    try {
      if (!OWNED_PATHS.has(f) && (await isTracked(worktreePath, f))) {
        console.log(`[merge] merge brought in a tracked ${f}; keeping it over Lattice's copy`);
        await fs.rm(bak, { force: true });
        continue;
      }
      await fs.rename(bak, dest);
    } catch { /* ignore */ }
  }
}

// After a clean merge, the merge commit may have brought in any owned
// file (LATTICE_TASK.md, MERGE_INSTRUCTIONS.md, .claude/settings.local.json)
// as a tracked file because main had it accidentally committed. Remove
// each from the index and commit the cleanup so the removal propagates
// when this branch is fast-forwarded into main.
//
// Iterates the central owned-file list rather than the shelved subset: a file
// can reach the index without ever having been shelved (it was tracked in this
// worktree all along, so shelving skipped it), and it should still be untracked
// here if main carried it through the merge.
export async function untrackOwnedFilesPostMerge(worktreePath: string): Promise<void> {
  const toRemove: string[] = [];
  for (const f of LATTICE_OWNED_FILE_PATHS) {
    const check = await exec('git', ['ls-files', f], worktreePath);
    if (check.stdout.trim()) toRemove.push(f);
  }
  if (toRemove.length === 0) return;
  await exec('git', ['rm', '--cached', ...toRemove], worktreePath);
  await exec(
    'git',
    [
      'commit',
      '-m',
      `Untrack Lattice-managed files [lattice-auto]\n\n${toRemove.map((f) => `- ${f}`).join('\n')}`,
    ],
    worktreePath,
  );
  console.log(`[merge] untracked accidentally committed lattice file(s): ${toRemove.join(', ')}`);
}
