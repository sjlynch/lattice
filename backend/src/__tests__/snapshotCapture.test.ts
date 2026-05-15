import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  buildSnapshotCleanupPlan,
  copyDirtyPathsToSnapshot,
  filterSafeDirtyPaths,
  parseStatus,
} from '../worktree/snapshot/capture.js';

test('parseStatus classifies porcelain modified and untracked paths', () => {
  const parsed = parseStatus([
    ' M src/unstaged.ts',
    'A  src/staged.ts',
    'D  src/deleted.ts',
    'R  src/old.ts -> src/new.ts',
    '?? notes/todo.md',
    '',
  ].join('\n'));

  assert.deepEqual(parsed.modified, [
    'src/unstaged.ts',
    'src/staged.ts',
    'src/deleted.ts',
    'src/old.ts -> src/new.ts',
  ]);
  assert.deepEqual(parsed.untracked, ['notes/todo.md']);
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
