// Pre-merge-run insurance: a `git bundle` snapshot of the entire object
// graph + all refs, written to `~/.lattice/git-backups/<projectHash>/`.
//
// This does NOT prevent `.git` damage — the layered guards (worktrees out
// of the project tree, the projectGit capability whitelist, the run
// circuit-breaker) do that. It's the "even if all of that is wrong"
// fallback: a bundle captures local-only branches and commits that a fresh
// `origin` clone wouldn't have, so recovery becomes
//
//     git init && git fetch <bundle> && git reset --hard <ref>
//
// instead of "re-clone from origin and lose whatever wasn't pushed". The
// file is compact (deduplicated objects, no working tree) and we keep only
// the most recent few per project.
//
// "Compact" is relative: a bundle is roughly the size of the repo's packs, so
// on a big repo each one is gigabytes (2026-09-22: 5 × 3.5 GB = 17 GB for one
// project, a new one per merge run — and a workflow Merge step loops merge
// runs back to back). Retention is therefore bounded by bytes as well as
// count, old bundles are pruned BEFORE the new one is written (never N+1 on
// disk), a bundle is skipped when the volume can't hold it above the
// worktree free-space reserve, and back-to-back runs share one bundle.
//
// `git bundle create <file>` writes through `<file>.lock` and renames it on
// success. A timeout kill (or a backend death mid-bundle) skips git's lockfile
// cleanup, and on Windows the orphaned `pack-objects` child can keep writing
// the whole pack into it — a multi-GB `<ts>.bundle.lock` per failed run that
// the `.bundle`-only retention never saw (2026-09-25). So a failed bundle
// removes its `.lock` too, every backup first sweeps stale leftovers, and a
// leftover that can't be deleted yet counts toward the byte budget while it
// is on disk.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { projectGit } from './projectGit.js';
import type { ExecOptions, ExecResult } from './exec.js';
import { projectHash } from '../projectPath.js';
import { freeBytesAt, formatBytes } from './diskSpace.js';
import { DEFAULT_MIN_FREE_DISK_GB, getGlobalSettings } from '../globalSettings.js';

const BACKUPS_BASE = path.join(os.homedir(), '.lattice', 'git-backups');
const GiB = 1024 ** 3;
// How many bundles to keep per project. A merge run produces one; this is
// "the last N runs' worth of pre-state".
const KEEP_PER_PROJECT = 5;
// ...and at most this many bytes of them. The newest bundle is always kept,
// even when it alone exceeds the budget.
const MAX_BYTES_PER_PROJECT = 8 * GiB;
// A bundle younger than this already captures the pre-run state closely
// enough; don't write another multi-GB copy for the next run in a burst.
const MIN_INTERVAL_MS = 10 * 60_000;
// `git bundle create --all` copies every pack, so its time scales with the
// repo: a flat 60 s killed every backup of a multi-GB repo (and leaked its
// `.lock`). Base + per-GiB of the expected bundle, capped so a pathological
// case doesn't stall the start of a merge run forever.
const BUNDLE_TIMEOUT_BASE_MS = 60_000;
const BUNDLE_TIMEOUT_PER_GIB_MS = 60_000;
const BUNDLE_TIMEOUT_MAX_MS = 20 * 60_000;
// A non-`.bundle` file untouched for longer than any bundle may run is debris
// from a killed/crashed `git bundle create`, never a live write.
export const LEFTOVER_STALE_MS = BUNDLE_TIMEOUT_MAX_MS + 60_000;

export function bundleTimeoutMs(expectedBytes: number): number {
  const scaled = BUNDLE_TIMEOUT_BASE_MS + Math.ceil((expectedBytes / GiB) * BUNDLE_TIMEOUT_PER_GIB_MS);
  return Math.min(BUNDLE_TIMEOUT_MAX_MS, scaled);
}

export type BundleFile = { name: string; bytes: number; mtimeMs: number };

// Seams for the regression test; production uses the defaults.
export type GitBackupDeps = {
  backupsDir: (repoRoot: string) => string;
  git: (repoRoot: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;
  freeBytesAt: (dir: string) => Promise<number | null>;
  minFreeBytes: () => Promise<number>;
  now: () => number;
  maxBytesPerProject: number;
};

const defaultDeps: GitBackupDeps = {
  backupsDir: projectBackupsDir,
  git: projectGit,
  freeBytesAt,
  minFreeBytes,
  now: () => Date.now(),
  maxBytesPerProject: MAX_BYTES_PER_PROJECT,
};

function projectBackupsDir(repoRoot: string): string {
  return path.join(BACKUPS_BASE, projectHash(repoRoot));
}

// Create a `--all` bundle of `repoRoot` and prune old ones. Best-effort:
// throws are the caller's to swallow (a failed backup must never block a
// merge run). Returns the bundle path on success, null if nothing was
// written.
export async function backupProjectGitBundle(
  repoRoot: string,
  depsOverride?: Partial<GitBackupDeps>,
): Promise<string | null> {
  const deps: GitBackupDeps = { ...defaultDeps, ...depsOverride };
  const dir = deps.backupsDir(repoRoot);
  await fs.mkdir(dir, { recursive: true });

  // Leftovers of a killed/crashed bundle that can't be deleted yet still
  // occupy the disk, so they eat into the byte budget.
  const leftoverBytes = await sweepLeftovers(dir, deps.now());

  const existing = await listBundles(dir);
  const newest = existing[existing.length - 1];
  if (newest && deps.now() - newest.mtimeMs < MIN_INTERVAL_MS) {
    console.log(`[git-backup] reusing ${newest.name} (under ${MIN_INTERVAL_MS / 60_000} min old)`);
    return null;
  }
  // The next bundle will be about as big as the last one (or the packs).
  const expected = newest?.bytes ?? (await packBytes(repoRoot));
  // Make room first: after pruning, the old bundles plus the new one (and any
  // leftovers) must fit the count and byte budgets.
  await pruneBundles(dir, existing, KEEP_PER_PROJECT - 1, deps.maxBytesPerProject - expected - leftoverBytes);

  const free = await deps.freeBytesAt(dir);
  const reserve = await deps.minFreeBytes();
  if (free !== null && free - expected < reserve) {
    console.warn(
      `[git-backup] skipping the pre-run bundle for ${repoRoot}: it needs ~${formatBytes(expected)}, ` +
        `${formatBytes(free)} is free and ${formatBytes(reserve)} is kept in reserve`,
    );
    return null;
  }

  const ts = new Date(deps.now()).toISOString().replace(/[:.]/g, '-');
  const bundlePath = path.join(dir, `${ts}.bundle`);
  // `git bundle create <file> --all` packs every ref (branches, tags,
  // remotes, HEAD) and their reachable objects. Read-only w.r.t. the repo.
  let r: ExecResult;
  try {
    r = await deps.git(repoRoot, ['bundle', 'create', bundlePath, '--all'], {
      timeoutMs: bundleTimeoutMs(expected),
    });
  } catch (err) {
    await removePartialBundle(bundlePath);
    throw err;
  }
  if (r.code !== 0) {
    await removePartialBundle(bundlePath);
    throw new Error(
      `git bundle create failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim() || 'unknown'}`,
    );
  }
  const stillLeft = await sweepLeftovers(dir, deps.now());
  await pruneBundles(dir, await listBundles(dir), KEEP_PER_PROJECT, deps.maxBytesPerProject - stillLeft);
  return bundlePath;
}

// Remove a failed bundle so it doesn't masquerade as a backup, and the
// `.lock` git was writing through: a killed git never renames or removes it.
// If an orphaned pack-objects still holds the `.lock` open (Windows) the rm
// fails; the next backup's sweep reclaims it once it goes stale.
async function removePartialBundle(bundlePath: string): Promise<void> {
  await fs.rm(bundlePath, { force: true }).catch(() => undefined);
  await fs.rm(`${bundlePath}.lock`, { force: true }).catch(() => undefined);
}

// Delete non-`.bundle` files in the backups dir (`<ts>.bundle.lock` from a
// killed `git bundle create`, or anything else a crash left) untouched for
// longer than any bundle may run. Returns the bytes of those still on disk —
// too young to be provably dead, or undeletable because a process holds them
// — so the caller can count them against the budget. Plain files only;
// nothing is recursed into.
async function sweepLeftovers(dir: string, now: number): Promise<number> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((f) => !f.endsWith('.bundle'));
  } catch {
    return 0;
  }
  let remaining = 0;
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try {
      st = await fs.lstat(p);
    } catch {
      continue; // vanished
    }
    if (!st.isFile()) continue;
    if (now - st.mtimeMs >= LEFTOVER_STALE_MS) {
      try {
        await fs.rm(p, { force: true });
        console.log(`[git-backup] removed stale leftover ${name} (${formatBytes(st.size)})`);
        continue;
      } catch (err) {
        console.warn(`[git-backup] could not remove stale leftover ${name}:`, err);
      }
    }
    remaining += st.size;
  }
  return remaining;
}

// Bundles oldest → newest. Names are ISO timestamps with `:`/`.` replaced by
// `-`, so lexical sort is chronological.
async function listBundles(dir: string): Promise<BundleFile[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith('.bundle')).sort();
  } catch {
    return [];
  }
  const out: BundleFile[] = [];
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(dir, name));
      out.push({ name, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* vanished */
    }
  }
  return out;
}

// Keep the newest bundles while they fit `maxCount` and `maxBytes`; delete the
// rest. The newest bundle always survives, whatever its size — a single
// oversize backup beats none, and the pre-write prune must never leave zero
// backups in case the new bundle is then skipped or fails.
export async function pruneBundles(
  dir: string,
  bundles: BundleFile[],
  maxCount: number,
  maxBytes: number,
): Promise<void> {
  let keptCount = 0;
  let keptBytes = 0;
  for (let i = bundles.length - 1; i >= 0; i -= 1) {
    const b = bundles[i];
    if (keptCount === 0 || (keptCount < maxCount && keptBytes + b.bytes <= maxBytes)) {
      keptCount += 1;
      keptBytes += b.bytes;
      continue;
    }
    await fs.rm(path.join(dir, b.name), { force: true }).catch(() => undefined);
  }
}

// Total size of the repo's pack files — a bundle's size when there's no
// previous bundle to go by.
async function packBytes(repoRoot: string): Promise<number> {
  const packDir = path.join(repoRoot, '.git', 'objects', 'pack');
  let total = 0;
  try {
    for (const name of await fs.readdir(packDir)) {
      if (!name.endsWith('.pack')) continue;
      total += (await fs.stat(path.join(packDir, name))).size;
    }
  } catch {
    /* worktree-style .git file, or unreadable — no estimate */
  }
  return total;
}

async function minFreeBytes(): Promise<number> {
  try {
    const gb = (await getGlobalSettings()).minFreeDiskGb;
    return (typeof gb === 'number' ? gb : DEFAULT_MIN_FREE_DISK_GB) * GiB;
  } catch {
    return DEFAULT_MIN_FREE_DISK_GB * GiB;
  }
}
