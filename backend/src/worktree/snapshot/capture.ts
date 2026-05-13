import path from 'node:path';
import fs from 'node:fs/promises';
import { projectGit } from '../projectGit.js';
import { isPathInsideRepo } from '../paths.js';
import { projectHash } from '../../projectPath.js';
import {
  EMPTY_HANDLE,
  SNAPSHOTS_BASE,
  writeSnapshotManifest,
  type SnapshotHandle,
} from './manifest.js';

// Parse `git status --porcelain=v1 -uall` output. We treat anything that
// isn't '? ?' (untracked) as 'modified' for snapshot purposes — staged,
// unstaged, deleted, type-changed all need preserving.
export function parseStatus(out: string): { modified: string[]; untracked: string[] } {
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
  const status = await projectGit(repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
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
    if (isPathInsideRepo(repoRoot, f)) return true;
    dropped.push(f);
    return false;
  });
  const untracked = rawUntracked.filter((f) => {
    if (isPathInsideRepo(repoRoot, f)) return true;
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
  await writeSnapshotManifest(dir, {
    version: 1,
    repoRoot,
    label,
    createdAt: Date.now(),
    modifiedTracked: copiedModified,
    untracked: copiedUntracked,
  });

  // Reset modified tracked files — but only the ones whose snapshot copy
  // succeeded. Resetting a file we failed to copy would replace the user's
  // uncommitted changes with HEAD's version and lose them irretrievably.
  // A file we failed to copy stays dirty in the working tree; the FF that
  // follows will fail with a clear error, the caller restores any partial
  // snapshot, and the user's data is intact.
  if (copiedModified.length > 0) {
    const co = await projectGit(repoRoot, ['checkout', 'HEAD', '--', ...copiedModified]);
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
