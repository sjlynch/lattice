// Copy-based working-tree snapshot. Replacement for
// `git stash --include-untracked`, which has a fatal failure mode for our
// purposes: if the stash is later lost (interrupted commit, dropped entry,
// process crash mid-pop), every untracked file it captured is silently
// deleted from the working tree. Two .git-deletion incidents on this
// project (2026-05-08, 2026-05-09) traced back to that pattern.
//
// What this gives us instead:
//   - Modified + untracked paths are *copied* to a stable directory under
//     ~/.lattice/snapshots/<projectHash>/<timestamp>-<label>/.
//   - The working tree is then reset (modified → HEAD, untracked → deleted)
//     so subsequent git operations (FF, merge) see a clean tree.
//   - On restore we copy the files back; on crash the snapshot dir is left
//     in place so the user can recover manually.
//   - Boot recovery (recoverPendingRunSnapshots) sweeps any orphaned
//     snapshots and restores them, so a server crash mid-run doesn't lose
//     work.
//
// Trade-off vs `git stash`: no 3-way merge on restore. If the FF brought
// a new version of a file the user had modified, the user's snapshotted
// version wins on restore (overwrites the FF'd version). This is
// conservative — the user's work is never silently lost — at the cost of
// potentially needing manual reconciliation. In practice this is fine
// because the merge happens *inside the worktree*, not in main, so main's
// working tree usually doesn't have user edits during a run.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { exec } from './exec.js';
import { projectHash } from '../projectPath.js';

const SNAPSHOTS_BASE = path.join(os.homedir(), '.lattice', 'snapshots');

export type SnapshotHandle = {
  // Absolute path to the snapshot directory. Empty string when no files
  // needed snapshotting (clean working tree); callers should treat that
  // case as a no-op.
  dir: string;
  modifiedTracked: string[];
  untracked: string[];
};

const EMPTY_HANDLE: SnapshotHandle = { dir: '', modifiedTracked: [], untracked: [] };

// Refuse paths that, when joined to repoRoot, escape the repo. Catches
// `..` traversal, absolute paths, and OS-specific aliases. Used both at
// snapshot creation (`git status` should never produce such paths, but
// defence in depth) and crucially at restore time, since the manifest
// is JSON on disk that may be tampered with or corrupted between runs.
//
// A bad path here would have `restoreSnapshot` writing to `.git/HEAD`,
// the user's home directory, or anywhere else with the user's privileges.
function isPathInsideRepo(file: string, repoRoot: string): boolean {
  if (typeof file !== 'string' || file.length === 0) return false;
  if (file.includes('\0')) return false;
  if (path.isAbsolute(file)) return false;
  const baseResolved = path.resolve(repoRoot);
  const joined = path.resolve(baseResolved, file);
  // Must be strictly inside baseResolved, not equal to it (no overwriting
  // the repo root itself) and not a sibling that shares a prefix.
  return joined.startsWith(baseResolved + path.sep);
}

// Parse `git status --porcelain=v1 -uall` output. We treat anything that
// isn't '? ?' (untracked) as 'modified' for snapshot purposes — staged,
// unstaged, deleted, type-changed all need preserving.
function parseStatus(out: string): { modified: string[]; untracked: string[] } {
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    const file = line.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(file);
    } else if (x !== ' ' || y !== ' ') {
      modified.push(file);
    }
  }
  return { modified, untracked };
}

// Snapshot every dirty path in `repoRoot` and reset the working tree.
// `label` becomes part of the snapshot dir name — use 'run' for the
// run-level snapshot, 'fastfwd-<branch>' for per-FF snapshots, etc.
export async function snapshotWorkingTree(
  repoRoot: string,
  label: string,
): Promise<SnapshotHandle> {
  const status = await exec(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    repoRoot,
  );
  if (status.code !== 0) {
    throw new Error(
      `[snapshot] git status failed in ${repoRoot}: ` +
        (status.stderr.trim() || status.stdout.trim() || 'unknown'),
    );
  }
  const { modified: rawModified, untracked: rawUntracked } = parseStatus(status.stdout);
  // Defence in depth: filter any path that would escape repoRoot before we
  // touch it. `git status --porcelain` shouldn't produce such paths, but
  // if it ever does — corrupt index, unusual quoting, custom porcelain
  // wrapper — the snapshot copy/delete loop must not reach outside the
  // repo. A path we drop here also won't be reset/deleted, so the user's
  // working tree is left exactly as it was for that path.
  const dropped: string[] = [];
  const modified = rawModified.filter((f) => {
    if (isPathInsideRepo(f, repoRoot)) return true;
    dropped.push(f);
    return false;
  });
  const untracked = rawUntracked.filter((f) => {
    if (isPathInsideRepo(f, repoRoot)) return true;
    dropped.push(f);
    return false;
  });
  if (dropped.length > 0) {
    console.error(
      `[snapshot] refused to capture ${dropped.length} path(s) outside ` +
        `${repoRoot}: ${dropped.slice(0, 5).join(', ')}` +
        (dropped.length > 5 ? ` (+${dropped.length - 5} more)` : ''),
    );
  }
  if (modified.length === 0 && untracked.length === 0) return EMPTY_HANDLE;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const dir = path.join(SNAPSHOTS_BASE, projectHash(repoRoot), `${ts}-${safeLabel}`);
  await fs.mkdir(dir, { recursive: true });

  // Copy each path and track which succeeded. We only reset / delete the
  // working-tree copy of files we successfully captured — otherwise a
  // transient I/O error during copy would silently lose the user's
  // uncommitted edits when the subsequent reset overwrote them.
  const copiedModified: string[] = [];
  const copiedUntracked: string[] = [];
  const copyFailures: string[] = [];
  for (const [files, target] of [
    [modified, copiedModified] as const,
    [untracked, copiedUntracked] as const,
  ]) {
    for (const file of files) {
      const src = path.join(repoRoot, file);
      const dst = path.join(dir, file);
      try {
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
        target.push(file);
      } catch (err) {
        copyFailures.push(file);
        console.warn(
          `[snapshot] copy ${file} failed: ${(err as Error).message}`,
        );
      }
    }
  }
  if (copyFailures.length > 0) {
    console.warn(
      `[snapshot] ${copyFailures.length} file(s) failed to copy and will ` +
        `NOT be reset/deleted from the working tree (preserves user data): ` +
        copyFailures.slice(0, 5).join(', ') +
        (copyFailures.length > 5 ? ` (+${copyFailures.length - 5} more)` : ''),
    );
  }

  // Manifest written AFTER copies so it reflects what was actually
  // captured. recoverPendingSnapshots reads this on boot — if a file isn't
  // listed, it won't be restored (correctly: we never copied it).
  await fs.writeFile(
    path.join(dir, '_lattice-snapshot.json'),
    JSON.stringify(
      {
        version: 1,
        repoRoot,
        label,
        createdAt: Date.now(),
        modifiedTracked: copiedModified,
        untracked: copiedUntracked,
      },
      null,
      2,
    ),
    'utf8',
  );

  // Reset modified tracked files — but only the ones whose snapshot copy
  // succeeded. Resetting a file we failed to copy would replace the user's
  // uncommitted changes with HEAD's version and lose them irretrievably.
  // A file we failed to copy stays dirty in the working tree; the FF that
  // follows will fail with a clear error, the caller restores any partial
  // snapshot, and the user's data is intact.
  if (copiedModified.length > 0) {
    const co = await exec(
      'git',
      ['checkout', 'HEAD', '--', ...copiedModified],
      repoRoot,
    );
    if (co.code !== 0) {
      console.warn(
        `[snapshot] git checkout HEAD -- (${copiedModified.length} files) ` +
          `exit ${co.code}: ${co.stderr.trim() || co.stdout.trim()}`,
      );
    }
  }
  // Delete only untracked files we successfully captured. Same rationale:
  // if the copy failed we leave the file alone rather than risk losing it.
  for (const file of copiedUntracked) {
    try {
      await fs.rm(path.join(repoRoot, file), { force: true, recursive: true });
    } catch {
      /* ignore */
    }
  }

  return { dir, modifiedTracked: copiedModified, untracked: copiedUntracked };
}

// Restore everything in the snapshot back into the working tree. Files
// the FF brought in for paths we'd snapshotted will be overwritten by the
// user's snapshotted version — this is intentional (see module header).
//
// On success the snapshot dir is removed. On any copy failure it stays so
// the user can recover from disk.
export async function restoreSnapshot(
  handle: SnapshotHandle,
  repoRoot: string,
): Promise<void> {
  if (!handle.dir) return;
  const all = [...handle.modifiedTracked, ...handle.untracked];
  // Path safety gate: the manifest is JSON on disk that may have been
  // written by an older Lattice build (without path validation), corrupted,
  // or tampered with. A bad entry — `..\..\.git\HEAD`, an absolute path,
  // a Windows drive root — would have us copy attacker-controlled content
  // out of the snapshot dir and into the user's filesystem with our
  // privileges. Filter unsafe entries and refuse to write them.
  const unsafe: string[] = [];
  const safe = all.filter((f) => {
    if (isPathInsideRepo(f, repoRoot)) return true;
    unsafe.push(f);
    return false;
  });
  if (unsafe.length > 0) {
    console.error(
      `[snapshot] refused to restore ${unsafe.length} unsafe path(s) ` +
        `(escapes ${repoRoot}): ${unsafe.slice(0, 5).join(', ')}` +
        (unsafe.length > 5 ? ` (+${unsafe.length - 5} more)` : ''),
    );
  }
  let failed = unsafe.length;
  for (const file of safe) {
    const src = path.join(handle.dir, file);
    const dst = path.join(repoRoot, file);
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    } catch (err) {
      failed += 1;
      console.warn(
        `[snapshot] restore ${file} failed: ${(err as Error).message}`,
      );
    }
  }
  if (failed === 0) {
    try {
      await fs.rm(handle.dir, { recursive: true, force: true });
    } catch {
      /* dir cleanup failure isn't fatal */
    }
  } else {
    console.warn(
      `[snapshot] ${failed} of ${all.length} file(s) failed to restore; ` +
        `snapshot kept at ${handle.dir} for manual recovery`,
    );
  }
}

// Drop a snapshot without restoring (caller decided the snapshot is
// no longer relevant — e.g. the FF failed and was rolled back through a
// different path).
export async function discardSnapshot(handle: SnapshotHandle): Promise<void> {
  if (!handle.dir) return;
  try {
    await fs.rm(handle.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// Boot-time recovery: scan ~/.lattice/snapshots/ for any leftover
// snapshots (a previous backend crashed mid-run) and restore them into
// their original repos. Logs each restore loudly. Idempotent on a clean
// snapshots dir (just enumerates and exits).
//
// Why this matters: the previous stash-based approach used a fixed label
// (`lattice-run-stash`) so a stash from a cancelled/crashed run was
// re-popped by the next run. The snapshot replacement needs equivalent
// semantics — otherwise a crash leaves the user's mods stranded in a
// snapshot dir until they manually copy them back.
export async function recoverPendingSnapshots(): Promise<void> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(SNAPSHOTS_BASE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.warn(`[snapshot] recovery scan failed: ${(err as Error).message}`);
    return;
  }
  for (const dirHash of projectDirs) {
    const projectSnapshotsDir = path.join(SNAPSHOTS_BASE, dirHash);
    let snapshots: string[];
    try {
      snapshots = await fs.readdir(projectSnapshotsDir);
    } catch {
      continue;
    }
    for (const snap of snapshots) {
      const snapDir = path.join(projectSnapshotsDir, snap);
      const manifestPath = path.join(snapDir, '_lattice-snapshot.json');
      let manifest:
        | {
            version: number;
            repoRoot: string;
            label: string;
            modifiedTracked: string[];
            untracked: string[];
          }
        | null = null;
      try {
        const raw = await fs.readFile(manifestPath, 'utf8');
        manifest = JSON.parse(raw);
      } catch {
        // Missing/corrupt manifest — leave it alone, user will see and
        // can clean up.
        continue;
      }
      if (!manifest || manifest.version !== 1) continue;
      // Defence in depth: a tampered manifest could claim repoRoot is
      // anywhere on disk (`C:\Windows\System32`, the user's home, another
      // project). The directory hash is computed from the canonical path,
      // so we recompute it from manifest.repoRoot and refuse to restore
      // if it doesn't match the directory the manifest lives in. A real
      // Lattice-written snapshot always satisfies this.
      const expectedHash = projectHash(manifest.repoRoot);
      if (expectedHash !== dirHash) {
        console.error(
          `[snapshot] refusing to restore ${snapDir} — manifest.repoRoot ` +
            `"${manifest.repoRoot}" hashes to ${expectedHash}, but it lives ` +
            `under directory ${dirHash}. Possibly tampered or relocated; ` +
            `leaving for manual inspection.`,
        );
        continue;
      }
      // Per-entry path validation happens inside restoreSnapshot, but we
      // also pre-check here so the log message reflects the real count.
      const allFiles = [
        ...(manifest.modifiedTracked ?? []),
        ...(manifest.untracked ?? []),
      ];
      const safeFiles = allFiles.filter((f) =>
        isPathInsideRepo(f, manifest!.repoRoot),
      );
      if (safeFiles.length !== allFiles.length) {
        console.error(
          `[snapshot] manifest at ${manifestPath} contains ` +
            `${allFiles.length - safeFiles.length} unsafe path(s); they ` +
            `will be skipped during restore.`,
        );
      }
      // Only auto-restore if the target repo still exists. If the user
      // moved/deleted the project, leave the snapshot in place.
      try {
        await fs.access(manifest.repoRoot);
      } catch {
        console.warn(
          `[snapshot] orphan snapshot ${snapDir} → repoRoot ${manifest.repoRoot} ` +
            `does not exist; leaving for manual cleanup`,
        );
        continue;
      }
      console.warn(
        `[snapshot] auto-restoring ${manifest.label} snapshot ` +
          `(${safeFiles.length} file(s)) → ${manifest.repoRoot}`,
      );
      await restoreSnapshot(
        {
          dir: snapDir,
          modifiedTracked: manifest.modifiedTracked ?? [],
          untracked: manifest.untracked ?? [],
        },
        manifest.repoRoot,
      );
    }
  }
}
