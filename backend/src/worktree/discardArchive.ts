// Keep-for-the-user archive of a task worktree's UNCOMMITTED edits, taken
// right before Lattice force-removes that worktree.
//
// Two paths discard a worktree that has no unmerged commits: a fresh ▶ Run's
// reconcile (`reconcile.ts`, "Run starts fresh") and the boot orphan sweep
// (`recovery/worktreeSweep.ts`). Both use `git worktree remove --force`, which
// silently deletes tracked modifications and untracked files. The unmerged-
// commit guard protects committed work only; this protects the rest.
//
// It reuses the copy-based snapshot machinery (`snapshot/`): the same status
// parse (`git status --porcelain=v1 -z --untracked-files=all`), the same
// containment filter, the same `mkdtemp` directory under
// `~/.lattice/snapshots/<projectHash>/<ts>-discarded-worktree-<slug>-XXXX/`,
// and the same copy routine (symlinks copied as links, never followed). Two
// deliberate differences from a merge snapshot:
//
//   1. NOTHING in the worktree is reset or deleted here — the caller removes
//      the whole worktree afterwards, and only when this returns `archived`
//      or `clean`. Any failure (git status, containment drop, one failed
//      copy, manifest write) returns `failed` and the caller KEEPS the
//      worktree: losing work is exactly what this exists to prevent.
//   2. The manifest is `_lattice-discarded-worktree.json`, NOT
//      `_lattice-snapshot.json`, and the payload lives under `files/`. Boot
//      `recoverPendingSnapshots` only acts on `_lattice-snapshot.json`, so an
//      archive is never auto-restored into the project tree (it holds a
//      worktree's edits, which were never the project checkout's) — and an
//      older backend that predates this module sees no manifest either.
//
// Retention: the newest `DISCARDED_WORKTREE_ARCHIVE_KEEP` archives per project
// are kept; older ones are removed after each new archive (guarded: strictly
// inside the project's snapshot dir, not a reparse point, links stripped
// first). Pending merge snapshots are never touched by that pruning.

import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from './exec.js';
import { projectHash } from '../projectPath.js';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { SNAPSHOTS_BASE } from './snapshot/manifest.js';
import { createSnapshotDirectory } from './snapshot/capture.js';
import { parseStatus, filterSafeDirtyPaths, logDroppedPaths } from './snapshot/pathClassification.js';
import { copyDirtyPathsToSnapshot, logCopyFailures } from './snapshot/copyAndCleanup.js';
import { LATTICE_EXCLUDE_PATTERNS, LATTICE_OWNED_FILE_PATHS } from './managedFiles.js';
import { isPathStrictlyInside } from './paths.js';
import { assertNotReparsePoint } from './cleanupSafety.js';
import { pruneReparsePointsUnder } from './reparsePoints.js';
import { pathExistsStrict } from './pathProbe.js';

export const DISCARDED_WORKTREE_MANIFEST_FILENAME = '_lattice-discarded-worktree.json';
export const DISCARDED_WORKTREE_LABEL_PREFIX = 'discarded-worktree-';
export const DISCARDED_WORKTREE_ARCHIVE_KEEP = 20;
const ARCHIVE_PAYLOAD_DIR = 'files';
const GIT_TIMEOUT_MS = 30_000;

export type DiscardedWorktreeManifest = {
  kind: 'discarded-worktree';
  version: 1;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  head: string;
  label: string;
  createdAt: number;
  // Repo-relative paths, copied under `<archive>/files/`.
  modifiedTracked: string[];
  untracked: string[];
  added: string[];
  // Tracked paths deleted in the worktree (nothing to copy; HEAD has them).
  deleted: string[];
};

export type WorktreeArchiveResult =
  | { status: 'absent' }
  | { status: 'clean' }
  | { status: 'archived'; dir: string; files: number }
  | { status: 'failed'; error: string };

function foldCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

async function samePhysicalPath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  return foldCase(path.resolve(ra)) === foldCase(path.resolve(rb));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

const EXCLUDE_MATCHERS = LATTICE_EXCLUDE_PATTERNS.map((pattern) => ({
  // gitignore semantics: a slash-free pattern matches at any depth.
  anyDepth: !pattern.includes('/'),
  re: globToRegExp(pattern),
}));
const OWNED = new Set<string>(LATTICE_OWNED_FILE_PATHS);

function normalizeRel(file: string): string {
  return file.replace(/\\/g, '/');
}

function isLatticeScratch(file: string): boolean {
  return normalizeRel(file).split('/')[0].toLowerCase() === '.lattice';
}

// Untracked Lattice-managed files (LATTICE_TASK.md, the Stop hook, Pi shims,
// Lattice's `.codex/hooks.json`, `*.lattice-bak`, …) are regenerated per run
// and are not the user's work.
export function isManagedUntrackedPath(file: string): boolean {
  const rel = normalizeRel(file);
  if (isLatticeScratch(rel)) return true;
  const base = rel.split('/').pop() ?? rel;
  return EXCLUDE_MATCHERS.some(({ anyDepth, re }) => re.test(rel) || (anyDepth && re.test(base)));
}

// A TRACKED path is filtered only when Lattice itself owns and rewrites it
// (e.g. a repo that tracks `.claude/settings.local.json`). `.codex/hooks.json`
// is deliberately absent from the owned set: when tracked it is the repo's own
// file (Lattice installs it if-absent), so an edit to it is the user's.
export function isManagedTrackedPath(file: string): boolean {
  return OWNED.has(normalizeRel(file));
}

function projectArchivesRoot(repoRoot: string): string {
  return path.join(SNAPSHOTS_BASE, projectHash(repoRoot));
}

// Guarded recursive removal of one archive dir we own.
async function removeArchiveDir(repoRoot: string, dir: string): Promise<void> {
  if (!isPathStrictlyInside(projectArchivesRoot(repoRoot), dir)) {
    throw new Error(`refusing to remove ${dir}: outside ${projectArchivesRoot(repoRoot)}`);
  }
  if (path.dirname(path.resolve(dir)) !== path.resolve(projectArchivesRoot(repoRoot))) {
    throw new Error(`refusing to remove ${dir}: not a direct child of the project's snapshot dir`);
  }
  await assertNotReparsePoint(dir);
  await pruneReparsePointsUnder(dir);
  await fs.rm(dir, { recursive: true, force: true });
}

export async function readDiscardedWorktreeManifest(dir: string): Promise<DiscardedWorktreeManifest | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dir, DISCARDED_WORKTREE_MANIFEST_FILENAME), 'utf8'));
    if (!value || value.kind !== 'discarded-worktree' || value.version !== 1) return null;
    if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null;
    return value as DiscardedWorktreeManifest;
  } catch {
    return null;
  }
}

// Keep the newest `keep` discarded-worktree archives for this project. Only
// directories carrying a valid discarded-worktree manifest are candidates, so
// pending merge snapshots (and anything unrecognised) are never removed here.
export async function pruneDiscardedWorktreeArchives(
  repoRoot: string,
  keep = DISCARDED_WORKTREE_ARCHIVE_KEEP,
): Promise<number> {
  const root = projectArchivesRoot(repoRoot);
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  const archives: { dir: string; createdAt: number }[] = [];
  for (const name of names) {
    if (!name.includes(DISCARDED_WORKTREE_LABEL_PREFIX)) continue;
    const dir = path.join(root, name);
    const manifest = await readDiscardedWorktreeManifest(dir);
    if (manifest) archives.push({ dir, createdAt: manifest.createdAt });
  }
  archives.sort((a, b) => b.createdAt - a.createdAt || b.dir.localeCompare(a.dir));
  let removed = 0;
  for (const { dir } of archives.slice(Math.max(0, keep))) {
    try {
      await removeArchiveDir(repoRoot, dir);
      removed += 1;
    } catch (err) {
      console.warn(`[worktree] archive retention: could not remove ${dir}: ${(err as Error).message}`);
    }
  }
  return removed;
}

async function worktreeGit(worktreePath: string, args: string[]) {
  return exec('git', args, worktreePath, { timeoutMs: GIT_TIMEOUT_MS });
}

// Archive the worktree's uncommitted changes (if any). Never mutates the
// worktree. `failed` means the caller must NOT remove the worktree.
export async function archiveUncommittedWorktreeChanges(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<WorktreeArchiveResult> {
  try {
    if (!(await pathExistsStrict(worktreePath))) return { status: 'absent' };
    if (!(await pathExistsStrict(path.join(worktreePath, '.git')))) {
      return { status: 'failed', error: 'worktree has no .git marker; cannot enumerate its changes' };
    }
    // `git` walks up from cwd when the checkout is broken. Only trust status
    // that is provably about THIS worktree.
    const top = await worktreeGit(worktreePath, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) {
      return { status: 'failed', error: `git rev-parse failed (exit ${top.code}): ${top.stderr.trim() || top.stdout.trim()}` };
    }
    if (!(await samePhysicalPath(top.stdout.trim(), worktreePath))) {
      return { status: 'failed', error: `git resolved a different toplevel (${top.stdout.trim()})` };
    }
    const status = await worktreeGit(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status.code !== 0) {
      return { status: 'failed', error: `git status failed (exit ${status.code}): ${status.stderr.trim() || status.stdout.trim()}` };
    }
    const parsed = parseStatus(status.stdout);
    const dirty = filterSafeDirtyPaths(worktreePath, {
      modified: parsed.modified.filter((f) => !isManagedTrackedPath(f)),
      untracked: parsed.untracked.filter((f) => !isManagedUntrackedPath(f)),
      added: (parsed.added ?? []).filter((f) => !isManagedTrackedPath(f) && !isLatticeScratch(f)),
      deleted: (parsed.deleted ?? []).filter((f) => !isManagedTrackedPath(f) && !isLatticeScratch(f)),
    });
    if (dirty.dropped.length > 0) {
      logDroppedPaths(worktreePath, dirty.dropped);
      return { status: 'failed', error: `${dirty.dropped.length} changed path(s) could not be safely captured` };
    }
    const total = dirty.modified.length + dirty.untracked.length + dirty.added.length + dirty.deleted.length;
    if (total === 0) return { status: 'clean' };

    const head = await worktreeGit(worktreePath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    const label = `${DISCARDED_WORKTREE_LABEL_PREFIX}${path.basename(worktreePath)}`;
    const dir = await createSnapshotDirectory(repoRoot, label);
    const copies = await copyDirtyPathsToSnapshot(worktreePath, path.join(dir, ARCHIVE_PAYLOAD_DIR), dirty);
    if (copies.copyFailures.length > 0) {
      logCopyFailures(copies.copyFailures);
      await removeArchiveDir(repoRoot, dir).catch((err) =>
        console.warn(`[worktree] could not remove incomplete archive ${dir}: ${(err as Error).message}`),
      );
      return { status: 'failed', error: `${copies.copyFailures.length} file(s) failed to copy` };
    }
    const manifest: DiscardedWorktreeManifest = {
      kind: 'discarded-worktree',
      version: 1,
      repoRoot,
      worktreePath,
      branch,
      head: head.code === 0 ? head.stdout.trim() : '',
      label,
      createdAt: Date.now(),
      modifiedTracked: copies.copiedModified,
      untracked: copies.copiedUntracked,
      added: copies.copiedAdded,
      deleted: [...dirty.deleted],
    };
    try {
      await atomicWriteFile(path.join(dir, DISCARDED_WORKTREE_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
    } catch (err) {
      await removeArchiveDir(repoRoot, dir).catch(() => { /* inert without a manifest */ });
      throw err;
    }
    await pruneDiscardedWorktreeArchives(repoRoot).catch((err) =>
      console.warn(`[worktree] archive retention sweep failed: ${(err as Error).message}`),
    );
    return { status: 'archived', dir, files: total };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}
