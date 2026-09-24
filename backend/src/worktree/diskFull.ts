// Merging on a (nearly) full disk.
//
// The worktree-admission guard (`diskSpace.ts`) keeps `minFreeDiskGb` free
// when a checkout is created, but everything else on the machine keeps
// writing afterwards, and on 2026-09-24 a 22-task merge run started with the
// disk already full: every worktree-side `git merge` died part-way ("sha1 file
// '…/index.lock' write error. Out of diskspace"), one task fast-forwarded main
// but could not save its qa state, and the run ploughed through all 22 tasks
// producing 22 errors. A merge needs little space — an index, a few objects,
// the task DB — so it gets a small floor of its own rather than the full
// reserve: merging is also what FREES space (each finalize removes a
// worktree), so it must still run when the disk is tight, just not when it is
// full.

import { freeBytesAt, formatBytes } from './diskSpace.js';

export const MERGE_MIN_FREE_BYTES = 1024 ** 3;

// git / Node / Windows wordings of "the disk is full", plus Lattice's own
// refusal below and the snapshot guard's.
const DISK_FULL_RE = /No space left on device|Out of diskspace|ENOSPC|not enough (?:free )?disk space|There is not enough space on the disk/i;

export function isDiskFullMessage(message: string): boolean {
  return DISK_FULL_RE.test(message);
}

// Why a merge must not start now, or null. Checks every volume the merge
// writes to (the project's `.git` and the worktree). An unreadable volume
// counts as fine — the guard never blocks work on its own blind spot.
export async function mergeDiskSpaceShortfall(
  paths: string[],
  deps: { freeBytesAt: typeof freeBytesAt } = { freeBytesAt },
): Promise<string | null> {
  for (const p of paths) {
    const free = await deps.freeBytesAt(p);
    if (free !== null && free < MERGE_MIN_FREE_BYTES) {
      return (
        `not enough free disk space to merge safely: ${formatBytes(free)} free where ${p} lives ` +
        `(a merge needs at least ${formatBytes(MERGE_MIN_FREE_BYTES)}) — nothing was changed; free disk space, then merge again`
      );
    }
  }
  return null;
}
