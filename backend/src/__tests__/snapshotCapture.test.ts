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
import {
  restoreSnapshot,
  SNAPSHOT_CONFLICT_SUFFIX,
} from '../worktree/snapshot/restore.js';

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
      { guardStaleOverwrite: false },
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

test('restoreSnapshot refuses a manifest listing .git/HEAD and never touches the gitdir (BUG 1)', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-gitguard-repo-'));
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-gitguard-'));
  try {
    // The repo's real gitdir contents we must never clobber.
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    // A tampered/corrupt snapshot carrying a matching payload for .git/HEAD.
    await fs.mkdir(path.join(snapshotDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(snapshotDir, '.git', 'HEAD'), 'ref: refs/heads/attacker\n', 'utf8');

    await restoreSnapshot(
      { dir: snapshotDir, modifiedTracked: ['.git/HEAD'], untracked: [] },
      repoRoot,
    );

    // The gitdir is untouched and the snapshot is retained for inspection.
    assert.equal(
      await fs.readFile(path.join(repoRoot, '.git', 'HEAD'), 'utf8'),
      'ref: refs/heads/main\n',
    );
    await fs.access(snapshotDir);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(snapshotDir, { recursive: true, force: true });
  }
});

test('restoreSnapshot (guardStaleOverwrite) does not clobber a path changed since capture (BUG 2)', async () => {
  // Mirrors boot recovery (recoverPendingSnapshots) re-applying a retained
  // snapshot: the user re-did their edit after a cancelled run, so on-disk
  // content differs from what the snapshot captured. It must NOT be silently
  // overwritten — the captured version is dropped beside it instead.
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-stale-repo-'));
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-stale-'));
  try {
    await fs.mkdir(path.join(snapshotDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(snapshotDir, 'src', 'tracked.ts'), 'USER_V1 (captured)', 'utf8');
    // What the user re-typed after their change vanished on cancel.
    await fs.writeFile(path.join(repoRoot, 'src', 'tracked.ts'), 'USER_V2 (redo)', 'utf8');

    await restoreSnapshot(
      { dir: snapshotDir, modifiedTracked: ['src/tracked.ts'], untracked: [] },
      repoRoot,
      { guardStaleOverwrite: true },
    );

    // On-disk redo preserved; captured version parked as a .lattice-conflict.
    assert.equal(
      await fs.readFile(path.join(repoRoot, 'src', 'tracked.ts'), 'utf8'),
      'USER_V2 (redo)',
    );
    assert.equal(
      await fs.readFile(
        path.join(repoRoot, 'src', 'tracked.ts' + SNAPSHOT_CONFLICT_SUFFIX),
        'utf8',
      ),
      'USER_V1 (captured)',
    );
    // Snapshot retained because a path diverged.
    await fs.access(snapshotDir);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(snapshotDir, { recursive: true, force: true });
  }
});

test('restoreSnapshot (guardStaleOverwrite) restores absent/unchanged paths without conflict copies', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-stale-ok-repo-'));
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-stale-ok-'));
  try {
    // Untracked file the run deleted and the user did NOT recreate (absent).
    await fs.writeFile(path.join(snapshotDir, 'new.txt'), 'brand new', 'utf8');
    // Tracked file whose on-disk content coincidentally already matches capture.
    await fs.mkdir(path.join(snapshotDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(snapshotDir, 'src', 'same.ts'), 'identical', 'utf8');
    await fs.writeFile(path.join(repoRoot, 'src', 'same.ts'), 'identical', 'utf8');

    await restoreSnapshot(
      { dir: snapshotDir, modifiedTracked: ['src/same.ts'], untracked: ['new.txt'] },
      repoRoot,
      { guardStaleOverwrite: true },
    );

    assert.equal(await fs.readFile(path.join(repoRoot, 'new.txt'), 'utf8'), 'brand new');
    assert.equal(await fs.readFile(path.join(repoRoot, 'src', 'same.ts'), 'utf8'), 'identical');
    // Nothing diverged, so no conflict copies and the snapshot dir is removed.
    await assert.rejects(
      fs.access(path.join(repoRoot, 'new.txt' + SNAPSHOT_CONFLICT_SUFFIX)),
      { code: 'ENOENT' },
    );
    await assert.rejects(fs.access(snapshotDir), { code: 'ENOENT' });
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(snapshotDir, { recursive: true, force: true });
  }
});

test('restoreSnapshot defaults to preserving newer on-disk content', async () => {
  // The immediate in-session restore (teardown / fastForwardMain) intentionally
  // overwrites — snapshot content wins over whatever the FF brought in.
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-nowin-repo-'));
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-nowin-'));
  try {
    await fs.mkdir(path.join(snapshotDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(snapshotDir, 'src', 'x.ts'), 'snapshot', 'utf8');
    await fs.writeFile(path.join(repoRoot, 'src', 'x.ts'), 'fast-forwarded', 'utf8');

    await restoreSnapshot(
      { dir: snapshotDir, modifiedTracked: ['src/x.ts'], untracked: [] },
      repoRoot,
    );

    assert.equal(await fs.readFile(path.join(repoRoot, 'src', 'x.ts'), 'utf8'), 'fast-forwarded');
    assert.equal(await fs.readFile(path.join(repoRoot, 'src', 'x.ts' + SNAPSHOT_CONFLICT_SUFFIX), 'utf8'), 'snapshot');
    await fs.access(snapshotDir);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(snapshotDir, { recursive: true, force: true });
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

    await cleanupCapturedUntrackedPaths(repoRoot, ['untracked-link.txt'], snapshotDir);
    await fs.rm(trackedLink, { force: true });
    await fs.writeFile(trackedLink, 'fast-forward regular file', 'utf8');

    await restoreSnapshot(
      {
        dir: snapshotDir,
        modifiedTracked: ['tracked-link.txt'],
        untracked: ['untracked-link.txt'],
      },
      repoRoot,
      { guardStaleOverwrite: false },
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
