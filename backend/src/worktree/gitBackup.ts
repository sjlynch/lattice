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

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { projectGit } from './projectGit.js';
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
// `git bundle create --all` on a large repo can take a few seconds — cap it
// so a pathological case doesn't stall the start of a merge run forever.
const BUNDLE_TIMEOUT_MS = 60_000;

export type BundleFile = { name: string; bytes: number; mtimeMs: number };

function projectBackupsDir(repoRoot: string): string {
  return path.join(BACKUPS_BASE, projectHash(repoRoot));
}

// Create a `--all` bundle of `repoRoot` and prune old ones. Best-effort:
// throws are the caller's to swallow (a failed backup must never block a
// merge run). Returns the bundle path on success, null if nothing was
// written.
export async function backupProjectGitBundle(repoRoot: string): Promise<string | null> {
  const dir = projectBackupsDir(repoRoot);
  await fs.mkdir(dir, { recursive: true });

  const existing = await listBundles(dir);
  const newest = existing[existing.length - 1];
  if (newest && Date.now() - newest.mtimeMs < MIN_INTERVAL_MS) {
    console.log(`[git-backup] reusing ${newest.name} (under ${MIN_INTERVAL_MS / 60_000} min old)`);
    return null;
  }
  // The next bundle will be about as big as the last one (or the packs).
  const expected = newest?.bytes ?? (await packBytes(repoRoot));
  // Make room first: after pruning, the old bundles plus the new one must fit
  // the count and byte budgets.
  await pruneBundles(dir, existing, KEEP_PER_PROJECT - 1, MAX_BYTES_PER_PROJECT - expected);

  const free = await freeBytesAt(dir);
  const reserve = await minFreeBytes();
  if (free !== null && free - expected < reserve) {
    console.warn(
      `[git-backup] skipping the pre-run bundle for ${repoRoot}: it needs ~${formatBytes(expected)}, ` +
        `${formatBytes(free)} is free and ${formatBytes(reserve)} is kept in reserve`,
    );
    return null;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bundlePath = path.join(dir, `${ts}.bundle`);
  // `git bundle create <file> --all` packs every ref (branches, tags,
  // remotes, HEAD) and their reachable objects. Read-only w.r.t. the repo.
  const r = await projectGit(repoRoot, ['bundle', 'create', bundlePath, '--all'], {
    timeoutMs: BUNDLE_TIMEOUT_MS,
  });
  if (r.code !== 0) {
    // Clean up a partial/empty file so it doesn't masquerade as a backup.
    await fs.rm(bundlePath, { force: true }).catch(() => undefined);
    throw new Error(
      `git bundle create failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim() || 'unknown'}`,
    );
  }
  await pruneBundles(dir, await listBundles(dir), KEEP_PER_PROJECT, MAX_BYTES_PER_PROJECT);
  return bundlePath;
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
