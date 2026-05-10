// Owned-file hygiene around a worktree `git merge`: shelve the untracked
// Lattice-managed files for the duration of the merge, restore them after,
// and untrack any owned file the merge dragged in from a prior accidental
// commit. The merge flow itself lives in merge.ts.

import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from './exec.js';
import { LATTICE_OWNED_FILE_PATHS } from './managedFiles.js';

// Files that Lattice writes into every worktree root but must never be
// committed. If a previous resolver Claude accidentally ran `git add .`
// and committed one of these, future merges into other worktrees fail with
// "untracked working tree files would be overwritten by merge." Moving
// them aside before `git merge` and restoring afterwards sidesteps this.
//
// `.claude/settings.local.json` is intentionally NOT shelved here even
// though Lattice owns it — it would conflict on merge if tracked, and
// auto-resolving the conflict (see resolveOwnedFileConflicts below) is
// cleaner than shelving + restoring (which would just cover up the
// tracked-file problem instead of fixing it).
const LATTICE_MANAGED_FILES = ['LATTICE_TASK.md', 'MERGE_INSTRUCTIONS.md'];

export async function shelveLatticeManagedFiles(worktreePath: string): Promise<string[]> {
  const shelved: string[] = [];
  for (const f of LATTICE_MANAGED_FILES) {
    const src = path.join(worktreePath, f);
    try {
      await fs.access(src);
      await fs.rename(src, `${src}.lattice-bak`);
      shelved.push(f);
    } catch { /* file absent — nothing to move */ }
  }
  return shelved;
}

export async function restoreLatticeManagedFiles(worktreePath: string, files: string[]): Promise<void> {
  for (const f of files) {
    try {
      await fs.rename(`${path.join(worktreePath, f)}.lattice-bak`, path.join(worktreePath, f));
    } catch { /* ignore */ }
  }
}

// After a clean merge, the merge commit may have brought in any owned
// file (LATTICE_TASK.md, MERGE_INSTRUCTIONS.md, .claude/settings.local.json)
// as a tracked file because main had it accidentally committed. Remove
// each from the index and commit the cleanup so the removal propagates
// when this branch is fast-forwarded into main.
//
// Iterates the central owned-file list rather than the shelved subset:
// `.claude/settings.local.json` isn't shelved (Layer 2 auto-resolves its
// conflicts instead) but should still be untracked here if main carried
// it through the merge.
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
