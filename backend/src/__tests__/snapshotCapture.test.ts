import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  buildSnapshotCleanupPlan,
  cleanupCapturedUntrackedPaths,
  copyDirtyPathsToSnapshot,
  filterSafeDirtyPaths,
  parseStatus,
} from '../worktree/snapshot/capture.js';
import { restoreSnapshot } from '../worktree/snapshot/restore.js';

test('parseStatus classifies porcelain (-z) modified and untracked paths', () => {
  // `-z` records are NUL-terminated; a rename emits the destination path,
  // then a SECOND NUL-separated field with the source path (no ` -> `).
  const parsed = parseStatus([
    ' M src/unstaged.ts',
    'A  src/staged.ts',
    'D  src/deleted.ts',
    'R  src/new.ts', 'src/old.ts',
    '?? notes/todo.md',
    '',
  ].join('\0'));

  assert.deepEqual(parsed.modified, [
    'src/unstaged.ts',
    'src/staged.ts',
    'src/deleted.ts',
    'src/new.ts',
  ]);
  assert.deepEqual(parsed.untracked, ['notes/todo.md']);
});

test('parseStatus captures renames as their new path and non-ASCII names verbatim', () => {
  // Regression: with the old newline parser a rename yielded the literal
  // `old -> new` and a non-ASCII name kept its octal-quoted form (e.g.
  // `"\305\233x.txt"`), so neither path could be copied and both were
  // silently dropped from the snapshot. With `-z` the destination path is
  // captured and the special-char name comes through verbatim.
  const parsed = parseStatus([
    'R  docs/new-name.md', 'docs/old-name.md', // staged rename
    'RM src/renamed.ts', 'src/before.ts', // renamed then modified in worktree
    'C  copy/dst.ts', 'copy/src.ts', // copy
    '?? śx.txt', // non-ASCII untracked, no quoting under -z
    ' M résumé.txt', // non-ASCII modified
    '',
  ].join('\0'));

  assert.deepEqual(parsed.modified, [
    'docs/new-name.md',
    'src/renamed.ts',
    'copy/dst.ts',
    'résumé.txt',
  ]);
  assert.deepEqual(parsed.untracked, ['śx.txt']);
});

test('filterSafeDirtyPaths drops repo escape paths and keeps safe paths', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-filter-'));
  const absoluteOutside = path.resolve(repoRoot, '..', 'outside.txt');

  const safe = filterSafeDirtyPaths(repoRoot, {
    modified: ['src/index.ts', '../outside.txt', ''],
    untracked: ['docs/readme.md', absoluteOutside],
  });

  assert.deepEqual(safe.modified, ['src/index.ts']);
  assert.deepEqual(safe.untracked, ['docs/readme.md']);
  assert.deepEqual(safe.dropped, ['../outside.txt', '', absoluteOutside]);

  await fs.rm(repoRoot, { recursive: true, force: true });
});

test('copyDirtyPathsToSnapshot records successes and failures separately', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-repo-'));
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-copy-'));
  await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'src', 'ok.ts'), 'ok', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'new.txt'), 'new', 'utf8');
  await fs.mkdir(path.join(repoRoot, 'dir-path'), { recursive: true });

  const copied = await copyDirtyPathsToSnapshot(repoRoot, snapshotDir, {
    modified: ['src/ok.ts', 'missing.ts'],
    untracked: ['new.txt', 'dir-path'],
  });

  assert.deepEqual(copied.copiedModified, ['src/ok.ts']);
  assert.deepEqual(copied.copiedUntracked, ['new.txt']);
  assert.deepEqual(copied.copyFailures, ['missing.ts', 'dir-path']);
  assert.equal(
    await fs.readFile(path.join(snapshotDir, 'src', 'ok.ts'), 'utf8'),
    'ok',
  );
  assert.equal(
    await fs.readFile(path.join(snapshotDir, 'new.txt'), 'utf8'),
    'new',
  );

  await fs.rm(repoRoot, { recursive: true, force: true });
  await fs.rm(snapshotDir, { recursive: true, force: true });
});

test('buildSnapshotCleanupPlan resets/deletes only successfully copied paths', () => {
  const plan = buildSnapshotCleanupPlan({
    copiedModified: ['src/ok.ts'],
    copiedUntracked: ['new.txt'],
    copyFailures: ['src/failed.ts', 'failed-new.txt'],
  });

  assert.deepEqual(plan.resetTracked, ['src/ok.ts']);
  assert.deepEqual(plan.deleteUntracked, ['new.txt']);
});

test('restoreSnapshot restores safe files and removes snapshot only after full success', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-restore-repo-'));
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-restore-'));
  try {
    await fs.mkdir(path.join(snapshotDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(snapshotDir, 'src', 'tracked.ts'), 'user edit', 'utf8');
    await fs.writeFile(path.join(snapshotDir, 'new.txt'), 'new file', 'utf8');
    await fs.writeFile(path.join(repoRoot, 'src', 'tracked.ts'), 'fast-forwarded', 'utf8');

    await restoreSnapshot(
      { dir: snapshotDir, modifiedTracked: ['src/tracked.ts'], untracked: ['new.txt'] },
      repoRoot,
    );

    assert.equal(await fs.readFile(path.join(repoRoot, 'src', 'tracked.ts'), 'utf8'), 'user edit');
    assert.equal(await fs.readFile(path.join(repoRoot, 'new.txt'), 'utf8'), 'new file');
    await assert.rejects(fs.access(snapshotDir), { code: 'ENOENT' });
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(snapshotDir, { recursive: true, force: true });
  }
});

test('restoreSnapshot refuses unsafe manifest paths and keeps snapshot for recovery', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-safe-repo-'));
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-safe-'));
  const outside = path.join(os.tmpdir(), `lattice-snapshot-outside-${Date.now()}.txt`);
  try {
    await fs.writeFile(outside, 'outside original', 'utf8');
    await restoreSnapshot(
      { dir: snapshotDir, modifiedTracked: ['../outside.txt', outside], untracked: [] },
      repoRoot,
    );

    assert.equal(await fs.readFile(outside, 'utf8'), 'outside original');
    await fs.access(snapshotDir);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(snapshotDir, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});

test('restoreSnapshot treats a missing snapshot source as failure and keeps snapshot', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-missing-repo-'));
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-missing-'));
  try {
    await restoreSnapshot(
      { dir: snapshotDir, modifiedTracked: ['missing.ts'], untracked: [] },
      repoRoot,
    );

    await assert.rejects(fs.access(path.join(repoRoot, 'missing.ts')), { code: 'ENOENT' });
    await fs.access(snapshotDir);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(snapshotDir, { recursive: true, force: true });
  }
});

test('snapshot capture and restore preserve symlinks without copying outside contents', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-link-repo-'));
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-link-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-link-outside-'));
  const outsideUntracked = path.join(outsideDir, 'untracked-target.txt');
  const outsideTracked = path.join(outsideDir, 'tracked-target.txt');
  const untrackedLink = path.join(repoRoot, 'untracked-link.txt');
  const trackedLink = path.join(repoRoot, 'tracked-link.txt');
  try {
    await fs.writeFile(outsideUntracked, 'outside untracked secret', 'utf8');
    await fs.writeFile(outsideTracked, 'outside tracked secret', 'utf8');
    try {
      await fs.symlink(outsideUntracked, untrackedLink);
      await fs.symlink(outsideTracked, trackedLink);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return;
      throw err;
    }

    const copied = await copyDirtyPathsToSnapshot(repoRoot, snapshotDir, {
      modified: ['tracked-link.txt'],
      untracked: ['untracked-link.txt'],
    });

    assert.deepEqual(copied, {
      copiedModified: ['tracked-link.txt'],
      copiedUntracked: ['untracked-link.txt'],
      copyFailures: [],
    });
    assert.equal((await fs.lstat(path.join(snapshotDir, 'untracked-link.txt'))).isSymbolicLink(), true);
    assert.equal((await fs.lstat(path.join(snapshotDir, 'tracked-link.txt'))).isSymbolicLink(), true);
    assert.equal(await fs.readlink(path.join(snapshotDir, 'untracked-link.txt')), outsideUntracked);
    assert.equal(await fs.readlink(path.join(snapshotDir, 'tracked-link.txt')), outsideTracked);

    await cleanupCapturedUntrackedPaths(repoRoot, ['untracked-link.txt']);
    await fs.rm(trackedLink, { force: true });
    await fs.writeFile(trackedLink, 'fast-forward regular file', 'utf8');

    await restoreSnapshot(
      {
        dir: snapshotDir,
        modifiedTracked: ['tracked-link.txt'],
        untracked: ['untracked-link.txt'],
      },
      repoRoot,
    );

    assert.equal((await fs.lstat(untrackedLink)).isSymbolicLink(), true);
    assert.equal((await fs.lstat(trackedLink)).isSymbolicLink(), true);
    assert.equal(await fs.readlink(untrackedLink), outsideUntracked);
    assert.equal(await fs.readlink(trackedLink), outsideTracked);
    assert.equal(await fs.readFile(outsideUntracked, 'utf8'), 'outside untracked secret');
    assert.equal(await fs.readFile(outsideTracked, 'utf8'), 'outside tracked secret');
    await assert.rejects(fs.access(snapshotDir), { code: 'ENOENT' });
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(snapshotDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});
