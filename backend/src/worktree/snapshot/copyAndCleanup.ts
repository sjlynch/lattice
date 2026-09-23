import path from 'node:path';
import fs from 'node:fs/promises';
import { projectGit } from '../projectGit.js';
import type { DirtyPaths, SnapshotCopyResult } from './capture.js';
import { isPathInsideRepo } from '../paths.js';
import { isSnapshotMetadataPath } from './manifest.js';
import { pathVersion } from './versions.js';

async function assertNoSymlinkParents(root: string, file: string): Promise<void> {
  const parts = file.split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`parent directory is a symlink: ${current}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`parent path is not a directory: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}

async function copySnapshotPath(
  repoRoot: string,
  snapshotDir: string,
  file: string,
): Promise<boolean> {
  const src = path.join(repoRoot, file);
  const dst = path.join(snapshotDir, file);
  try {
    // Payloads share the snapshot root with its manifest. Leave a colliding
    // repository path untouched rather than replace its backup with metadata.
    if (isSnapshotMetadataPath(file)) throw new Error('path reserved for snapshot metadata');
    await assertNoSymlinkParents(repoRoot, file);
    const stat = await fs.lstat(src);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error('not a regular file or symlink');
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    if (stat.isSymbolicLink()) {
      // Preserve the link itself. `copyFile` follows symlinks, which would
      // leak outside-repo file contents when a dirty repo symlink targets a
      // path elsewhere on disk, and restore would turn the link into a file.
      const target = await fs.readlink(src);
      await fs.symlink(target, dst);
    } else {
      await fs.copyFile(src, dst);
    }
    return true;
  } catch (err) {
    console.warn(
      `[snapshot] copy ${file} failed: ${(err as Error).message}`,
    );
    return false;
  }
}

export async function copyDirtyPathsToSnapshot(
  repoRoot: string,
  snapshotDir: string,
  dirty: DirtyPaths,
): Promise<SnapshotCopyResult> {
  // Copy each path and track which succeeded. We only reset / delete the
  // working-tree copy of files we successfully captured — otherwise a
  // transient I/O error during copy would silently lose the user's
  // uncommitted edits when the subsequent reset overwrote them.
  const copiedModified: string[] = [];
  const copiedUntracked: string[] = [];
  const copiedAdded: string[] = [];
  const copyFailures: string[] = [];
  for (const [files, target] of [
    [dirty.modified, copiedModified] as const,
    [dirty.untracked, copiedUntracked] as const,
    [dirty.added ?? [], copiedAdded] as const,
  ]) {
    for (const file of files) {
      if (await copySnapshotPath(repoRoot, snapshotDir, file)) {
        target.push(file);
      } else {
        copyFailures.push(file);
      }
    }
  }
  return { copiedModified, copiedUntracked, copiedAdded, copyFailures };
}

export function logCopyFailures(copyFailures: string[]): void {
  if (copyFailures.length === 0) return;
  console.warn(
    `[snapshot] ${copyFailures.length} file(s) failed to copy and will ` +
      `NOT be reset/deleted from the working tree (preserves user data): ` +
      copyFailures.slice(0, 5).join(', ') +
      (copyFailures.length > 5 ? ` (+${copyFailures.length - 5} more)` : ''),
  );
}

export async function resetTrackedSnapshotPaths(
  repoRoot: string,
  resetTracked: string[],
  snapshotDir?: string,
): Promise<void> {
  // Reset modified tracked files — but only the ones whose snapshot copy
  // succeeded. Resetting a file we failed to copy would replace the user's
  // uncommitted changes with HEAD's version and lose them irretrievably.
  // A file we failed to copy stays dirty in the working tree; the FF that
  // follows will fail with a clear error, the caller restores any partial
  // snapshot, and the user's data is intact.
  resetTracked = await unchangedSinceCopy(repoRoot, resetTracked, snapshotDir);
  if (resetTracked.length === 0) return;
  await runGitOnPathsResilient(repoRoot, ['checkout', 'HEAD', '--'], resetTracked);
}

// Run `git <prefix…> :(literal)<file>…` once for the whole set and, when that
// exits non-zero, once more per path. Git validates every pathspec up front and
// refuses the WHOLE command on one bad one (`error: pathspec ':(literal)x' did
// not match any file(s) known to git`), so a single unexpected entry used to
// leave every other path in the batch dirty — and the fast-forward that
// followed failed with "local changes would be overwritten" for every task.
// Both commands are idempotent per path, so re-running the ones the batch did
// process is harmless. Returns the paths git accepted.
//
// The set is also split into chunks that fit the OS command line: Windows caps
// a CreateProcess command line at 32,767 characters, and a large dirty tree
// (1,610 paths on 2026-09-23) made the single call throw `spawn ENAMETOOLONG`
// — an exception, not an exit code, so the per-path retry never ran, the
// snapshot failed after copying ~1 GB, and every fast-forward repeated it
// until the disk filled.
export const GIT_ARGV_CHAR_BUDGET = 8_000;

export function chunkPathsForArgv(files: string[], budget = GIT_ARGV_CHAR_BUDGET): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const file of files) {
    const cost = file.length + 12; // `:(literal)` + separator
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function runGitOnPathsResilient(
  repoRoot: string,
  prefix: string[],
  files: string[],
): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = [];
  const failed: string[] = [];
  for (const chunk of chunkPathsForArgv(files)) {
    const result = await runGitOnChunk(repoRoot, prefix, chunk);
    ok.push(...result.ok);
    failed.push(...result.failed);
  }
  return { ok, failed };
}

async function runGitOnChunk(
  repoRoot: string,
  prefix: string[],
  files: string[],
): Promise<{ ok: string[]; failed: string[] }> {
  const literal = (file: string) => `:(literal)${file}`;
  const label = `git ${prefix.join(' ')}`;
  const run = async (paths: string[]): Promise<{ code: number; detail: string }> => {
    try {
      const r = await projectGit(repoRoot, [...prefix, ...paths.map(literal)]);
      return { code: r.code, detail: r.stderr.trim() || r.stdout.trim() };
    } catch (err) {
      // A spawn failure (ENAMETOOLONG, EMFILE, …) is a failed batch too.
      return { code: -1, detail: (err as Error).message };
    }
  };
  const batch = await run(files);
  if (batch.code === 0) return { ok: [...files], failed: [] };
  console.warn(
    `[snapshot] ${label} (${files.length} files) exit ${batch.code}: ${batch.detail}` +
      (files.length > 1 ? ' — retrying per path' : ''),
  );
  if (files.length === 1) return { ok: [], failed: [...files] };
  const ok: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    const one = await run([file]);
    if (one.code === 0) {
      ok.push(file);
    } else {
      failed.push(file);
      console.warn(`[snapshot] ${label} ${file} exit ${one.code}: ${one.detail}`);
    }
  }
  return { ok, failed };
}

// Staged-new paths (in the index, not in HEAD): de-index with
// `git reset HEAD -- <path>` — `checkout HEAD` cannot reset a path HEAD
// doesn't have — then delete the working copy the same way an untracked
// capture is deleted (only after verifying the copy still matches). A path
// whose reset failed keeps its working copy: deleting it would leave a
// staged-add with no file behind it.
export async function unstageAddedSnapshotPaths(
  repoRoot: string,
  unstageAdded: string[],
  snapshotDir?: string,
): Promise<void> {
  unstageAdded = await unchangedSinceCopy(repoRoot, unstageAdded, snapshotDir);
  if (unstageAdded.length === 0) return;
  const { ok } = await runGitOnPathsResilient(repoRoot, ['reset', 'HEAD', '--'], unstageAdded);
  await cleanupCapturedUntrackedPaths(repoRoot, ok, snapshotDir);
}

// Locally deleted tracked paths (in HEAD, absent on disk): bring HEAD's copy
// back so the fast-forward sees a clean tree. Nothing is copied — the content
// is HEAD's — and restore re-applies the deletion. A path that has reappeared
// on disk since `git status` ran is left alone (the checkout would overwrite
// whatever was just put there).
export async function restoreDeletedSnapshotPaths(
  repoRoot: string,
  deleted: string[],
): Promise<void> {
  const absent: string[] = [];
  for (const file of deleted) {
    if (!isPathInsideRepo(repoRoot, file) || isSnapshotMetadataPath(file)) continue;
    try {
      await assertNoSymlinkParents(repoRoot, file);
      if ((await pathVersion(path.join(repoRoot, file))) !== null) {
        console.warn(`[snapshot] ${file} reappeared after capture; leaving it in place`);
        continue;
      }
      absent.push(file);
    } catch (err) {
      console.warn(`[snapshot] cannot verify deleted path ${file}; leaving it: ${(err as Error).message}`);
    }
  }
  if (absent.length === 0) return;
  await runGitOnPathsResilient(repoRoot, ['checkout', 'HEAD', '--'], absent);
}

export async function cleanupCapturedUntrackedPaths(
  repoRoot: string,
  deleteUntracked: string[],
  snapshotDir?: string,
): Promise<void> {
  // Delete only untracked files we successfully captured. Same rationale:
  // if the copy failed we leave the file alone rather than risk losing it.
  for (const file of deleteUntracked) {
    try {
      if (!isPathInsideRepo(repoRoot, file)) continue;
      await assertNoSymlinkParents(repoRoot, file);
      if (!(await unchangedSinceCopy(repoRoot, [file], snapshotDir)).length) continue;
      // Capture accepts files and links only. A directory here appeared AFTER
      // capture and contains unsnapshotted work; never recursively remove it.
      await fs.rm(path.join(repoRoot, file), { force: true, recursive: false });
    } catch {
      /* ignore */
    }
  }
}

async function unchangedSinceCopy(repoRoot: string, files: string[], snapshotDir?: string): Promise<string[]> {
  if (!snapshotDir) return []; // No captured version to compare: refuse cleanup.
  const unchanged: string[] = [];
  for (const file of files) {
    if (!isPathInsideRepo(repoRoot, file) || isSnapshotMetadataPath(file)) continue;
    try {
      await assertNoSymlinkParents(repoRoot, file);
      await assertNoSymlinkParents(snapshotDir, file);
      const [current, copied] = await Promise.all([
        pathVersion(path.join(repoRoot, file)),
        pathVersion(path.join(snapshotDir, file)),
      ]);
      if (copied !== null && current === copied) { unchanged.push(file); continue; }
      console.warn(`[snapshot] ${file} changed after capture; leaving the newer working-tree version in place`);
    } catch (err) {
      console.warn(`[snapshot] cannot verify ${file} before cleanup; leaving it in place: ${(err as Error).message}`);
    }
  }
  return unchanged;
}
