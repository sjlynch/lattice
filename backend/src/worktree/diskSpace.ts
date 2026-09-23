// Disk-space admission for new task worktrees.
//
// A task worktree is a full checkout of HEAD — every tracked file, Git LFS
// content included — so on a large repo each one costs gigabytes, and a
// ready_to_merge task keeps its checkout until it merges. The spawn queue's
// softCap counts agents, not bytes, so a fan-out of queued workflows could fill
// the disk (2026-09-22: 16 checkouts × 6.5 GB of a repo carrying 4.3 GB of LFS
// assets, with `maxConcurrentAgents` at 50). This guard runs right before
// `git worktree add` and admits the checkout only when
//
//   free space − bytes reserved by setups still checking out
//              − this checkout's estimated size  ≥  minFreeDiskGb
//
// Otherwise it throws SpawnDiskSpaceError, which the spawn queue treats as a
// deferral: the task stays Open + queued, and is retried on a backoff and as
// soon as a worktree cleanup frees space. Nothing about the checkout itself
// changes — the agent still gets the complete tree.
//
// The estimate is repo-agnostic: the allocated size of every file `git
// ls-files` lists in the main checkout, which is what a fresh worktree of HEAD
// materializes (LFS content included when the main checkout has it smudged).
// Cached per repo for a few minutes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { projectGit } from './projectGit.js';
import { exec } from './exec.js';
import { DEFAULT_MIN_FREE_DISK_GB, getGlobalSettings } from '../globalSettings.js';
import { SpawnDiskSpaceError } from '../spawnQueue/types.js';

const GiB = 1024 ** 3;
// How long a deferred run waits before re-checking (a cleanup cuts it short).
export const DISK_RETRY_MS = 30_000;
const ESTIMATE_TTL_MS = 10 * 60_000;
const LS_FILES_TIMEOUT_MS = 60_000;
const STAT_CONCURRENCY = 64;
// Files occupy whole clusters; 4 KiB is the NTFS / ext4 default.
const CLUSTER_BYTES = 4096;

type CachedEstimate = { bytes: number; at: number };
const estimates = new Map<string, CachedEstimate>();
const estimating = new Map<string, Promise<number | null>>();
// Sum of estimates for setups admitted but not yet done checking out. Global
// rather than per volume: over-counting another volume's setup only makes the
// guard more conservative for a moment.
let reservedBytes = 0;

export type DiskSpaceDeps = {
  estimateCheckoutBytes: (repoRoot: string) => Promise<number | null>;
  freeBytesAt: (target: string) => Promise<number | null>;
  minFreeBytes: () => Promise<number>;
};

// Free bytes available to this user on the volume holding `target`, walking up
// to the nearest existing ancestor. null when it cannot be determined.
export async function freeBytesAt(target: string): Promise<number | null> {
  let dir = path.resolve(target);
  for (;;) {
    try {
      const s = await fs.statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch (err) {
      const parent = path.dirname(dir);
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dir) return null;
      dir = parent;
    }
  }
}

// `checkoutDir` is the main checkout (through projectGit) or, via
// `recordWorktreeCheckoutSize`, a disposable task worktree (plain exec, as for
// all worktree-side git).
async function measureTrackedBytes(checkoutDir: string, isWorktree = false): Promise<number | null> {
  const args = ['ls-files', '-z'];
  const opts = { timeoutMs: LS_FILES_TIMEOUT_MS };
  const listed = isWorktree ? await exec('git', args, checkoutDir, opts) : await projectGit(checkoutDir, args, opts);
  if (listed.code !== 0) return null;
  const repoRoot = checkoutDir;
  const files = listed.stdout.split('\0').filter(Boolean);
  let total = 0;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const rel = files[next++];
      try {
        const st = await fs.lstat(path.join(repoRoot, rel));
        // Submodules list as directories; a deleted file is simply absent.
        if (st.isFile()) total += Math.ceil(st.size / CLUSTER_BYTES) * CLUSTER_BYTES;
      } catch {
        /* missing from the main checkout — not counted */
      }
    }
  };
  await Promise.all(Array.from({ length: STAT_CONCURRENCY }, worker));
  return total;
}

// Estimated bytes a new worktree of `repoRoot` will take. Single-flighted and
// cached; a stale cache entry is still returned if a refresh fails.
export async function estimateCheckoutBytes(repoRoot: string): Promise<number | null> {
  const key = path.resolve(repoRoot).toLowerCase();
  const cached = estimates.get(key);
  if (cached && Date.now() - cached.at < ESTIMATE_TTL_MS) return cached.bytes;
  let pending = estimating.get(key);
  if (!pending) {
    pending = measureTrackedBytes(repoRoot)
      .catch((err) => {
        console.warn(`[worktree] could not estimate checkout size for ${repoRoot}:`, err);
        return null;
      })
      .then((bytes) => {
        if (bytes !== null) estimates.set(key, { bytes, at: Date.now() });
        return bytes;
      })
      .finally(() => estimating.delete(key));
    estimating.set(key, pending);
  }
  const measured = (await pending) ?? cached?.bytes ?? null;
  // A main checkout can under-represent a fresh worktree (LFS objects the user
  // never smudged locally, a sparse checkout); what a real worktree measured
  // wins when larger.
  const observed = observedWorktreeBytes.get(key);
  if (measured === null) return observed ?? null;
  return observed !== undefined ? Math.max(measured, observed) : measured;
}

// Largest checkout size actually observed for a new worktree, per repo.
const observedWorktreeBytes = new Map<string, number>();

// Called (not awaited) right after `git worktree add` lands a checkout: measure
// it and remember the size, so the next estimate reflects reality. Never throws.
export async function recordWorktreeCheckoutSize(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    const bytes = await measureTrackedBytes(worktreePath, true);
    if (bytes === null) return;
    const key = path.resolve(repoRoot).toLowerCase();
    observedWorktreeBytes.set(key, Math.max(bytes, observedWorktreeBytes.get(key) ?? 0));
  } catch {
    /* best-effort */
  }
}

// The free-space reserve every disk-consuming step keeps (globalSettings
// minFreeDiskGb): worktree checkouts, pre-run bundles, working-tree snapshots.
export async function minFreeDiskBytes(): Promise<number> {
  try {
    const gb = (await getGlobalSettings()).minFreeDiskGb;
    return (typeof gb === 'number' ? gb : DEFAULT_MIN_FREE_DISK_GB) * GiB;
  } catch {
    return DEFAULT_MIN_FREE_DISK_GB * GiB;
  }
}

const defaultDeps: DiskSpaceDeps = {
  estimateCheckoutBytes,
  freeBytesAt,
  minFreeBytes: minFreeDiskBytes,
};

export function formatBytes(bytes: number): string {
  return bytes >= GiB ? `${(bytes / GiB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export type DiskReservation = { release: () => void };

// Admit (and reserve space for) one worktree checkout, or throw
// SpawnDiskSpaceError. Call `release()` once the checkout has landed on disk or
// failed. When space or size cannot be measured the checkout is admitted — the
// guard never blocks work on its own blind spot.
export async function reserveWorktreeDiskSpace(
  repoRoot: string,
  worktreesDir: string,
  deps: DiskSpaceDeps = defaultDeps,
): Promise<DiskReservation> {
  const estimate = await deps.estimateCheckoutBytes(repoRoot);
  const minFree = await deps.minFreeBytes();
  // Last await: everything below runs synchronously, so two concurrent setups
  // can't both pass the check against the same `reservedBytes`.
  const free = await deps.freeBytesAt(worktreesDir);
  if (estimate === null || free === null) {
    console.warn(
      `[worktree] disk-space check skipped for ${repoRoot} ` +
        `(${estimate === null ? 'checkout size' : 'free space'} unknown)`,
    );
    return { release: () => {} };
  }
  const available = free - reservedBytes - minFree;
  if (estimate > available) {
    throw new SpawnDiskSpaceError(
      `not enough disk space for another worktree: a checkout of this project takes ~${formatBytes(estimate)}, ` +
        `${formatBytes(free)} is free` +
        (reservedBytes > 0 ? ` (${formatBytes(reservedBytes)} already reserved by worktrees being created)` : '') +
        ` and Lattice keeps ${formatBytes(minFree)} free (global setting minFreeDiskGb). ` +
        'The run stays queued and starts once space frees up — merging Ready-to-Merge tasks releases their worktrees.',
      DISK_RETRY_MS,
    );
  }
  reservedBytes += estimate;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      reservedBytes = Math.max(0, reservedBytes - estimate);
    },
  };
}

// Test seam.
export function resetDiskSpaceStateForTests(): void {
  observedWorktreeBytes.clear();
  estimates.clear();
  estimating.clear();
  reservedBytes = 0;
}
