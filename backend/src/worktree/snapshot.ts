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
  const { modified, untracked } = parseStatus(status.stdout);
  if (modified.length === 0 && untracked.length === 0) return EMPTY_HANDLE;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const dir = path.join(SNAPSHOTS_BASE, projectHash(repoRoot), `${ts}-${safeLabel}`);
  await fs.mkdir(dir, { recursive: true });
  // Manifest first: even if the file copies below partially fail, we know
  // what was supposed to be in the snapshot.
  await fs.writeFile(
    path.join(dir, '_lattice-snapshot.json'),
    JSON.stringify(
      {
        version: 1,
        repoRoot,
        label,
        createdAt: Date.now(),
        modifiedTracked: modified,
        untracked,
      },
      null,
      2,
    ),
    'utf8',
  );

  // Copy each path. Failures here are logged and swallowed — better to
  // skip an unreadable file than abort the whole snapshot. The git reset
  // below will still happen, so the FF can proceed.
  for (const file of [...modified, ...untracked]) {
    const src = path.join(repoRoot, file);
    const dst = path.join(dir, file);
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    } catch (err) {
      console.warn(
        `[snapshot] copy ${file} failed: ${(err as Error).message}`,
      );
    }
  }

  // Reset modified tracked files. One git invocation for all of them
  // avoids per-file fork overhead. If git fails (e.g. a deleted-and-
  // recreated path), the FF will surface a clearer error than we could.
  if (modified.length > 0) {
    const co = await exec(
      'git',
      ['checkout', 'HEAD', '--', ...modified],
      repoRoot,
    );
    if (co.code !== 0) {
      console.warn(
        `[snapshot] git checkout HEAD -- (${modified.length} files) ` +
          `exit ${co.code}: ${co.stderr.trim() || co.stdout.trim()}`,
      );
    }
  }
  // Delete untracked files. Best-effort: a leftover doesn't break the FF.
  for (const file of untracked) {
    try {
      await fs.rm(path.join(repoRoot, file), { force: true, recursive: true });
    } catch {
      /* ignore */
    }
  }

  return { dir, modifiedTracked: modified, untracked };
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
  let failed = 0;
  for (const file of all) {
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
  for (const projectHash of projectDirs) {
    const projectSnapshotsDir = path.join(SNAPSHOTS_BASE, projectHash);
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
          `(${manifest.modifiedTracked.length + manifest.untracked.length} file(s)) → ${manifest.repoRoot}`,
      );
      await restoreSnapshot(
        {
          dir: snapDir,
          modifiedTracked: manifest.modifiedTracked,
          untracked: manifest.untracked,
        },
        manifest.repoRoot,
      );
    }
  }
}
