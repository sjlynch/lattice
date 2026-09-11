import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  copyDirtyPathsToSnapshot,
  createSnapshotDirectory,
  cleanupCapturedUntrackedPaths,
  writeCapturedSnapshotManifest,
} from '../worktree/snapshot/capture.js';
import { isSupportedSnapshotManifest, SNAPSHOT_MANIFEST_FILENAME } from '../worktree/snapshot/manifest.js';
import { restoreSnapshot } from '../worktree/snapshot/restore.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-safety-'));
  const repo = path.join(root, 'repo');
  const snapshot = path.join(root, 'snapshot');
  await fs.mkdir(repo);
  await fs.mkdir(snapshot);
  return { root, repo, snapshot };
}

test('snapshot metadata cannot overwrite a captured root file with the same name', async (t) => {
  const { root, repo, snapshot } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, SNAPSHOT_MANIFEST_FILENAME), 'irreplaceable local notes');
  const copied = await copyDirtyPathsToSnapshot(repo, snapshot, {
    modified: [], untracked: [SNAPSHOT_MANIFEST_FILENAME],
  });
  await writeCapturedSnapshotManifest(repo, 'test', snapshot, copied);
  await cleanupCapturedUntrackedPaths(repo, copied.copiedUntracked, snapshot);
  await restoreSnapshot({ dir: snapshot, modifiedTracked: copied.copiedModified, untracked: copied.copiedUntracked }, repo);
  assert.equal(await fs.readFile(path.join(repo, SNAPSHOT_MANIFEST_FILENAME), 'utf8'), 'irreplaceable local notes');
});

test('snapshot recovery preserves existing conflict copies and reuses identical ones on repeated boots', async (t) => {
  const { root, repo, snapshot } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(snapshot, 'work.ts'), 'original captured work');
  await fs.writeFile(path.join(repo, 'work.ts'), 'new user work');
  await fs.writeFile(path.join(repo, 'work.ts.lattice-conflict'), 'user reconciliation in progress');
  const handle = { dir: snapshot, modifiedTracked: ['work.ts'], untracked: [] };
  await restoreSnapshot(handle, repo, { guardStaleOverwrite: true });
  assert.equal(await fs.readFile(path.join(repo, 'work.ts.lattice-conflict'), 'utf8'), 'user reconciliation in progress');
  assert.equal(await fs.readFile(path.join(repo, 'work.ts.lattice-conflict.1'), 'utf8'), 'original captured work');
  await restoreSnapshot(handle, repo, { guardStaleOverwrite: true });
  assert.deepEqual((await fs.readdir(repo)).sort(), ['work.ts', 'work.ts.lattice-conflict', 'work.ts.lattice-conflict.1']);
});

test('snapshot cleanup never recursively removes a file replaced by a directory after capture', async (t) => {
  const { root, repo, snapshot } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, 'notes'), 'old file');
  const copied = await copyDirtyPathsToSnapshot(repo, snapshot, { modified: [], untracked: ['notes'] });
  await fs.unlink(path.join(repo, 'notes'));
  await fs.mkdir(path.join(repo, 'notes'));
  await fs.writeFile(path.join(repo, 'notes', 'new.txt'), 'new work not captured');
  await cleanupCapturedUntrackedPaths(repo, copied.copiedUntracked, snapshot);
  assert.equal(await fs.readFile(path.join(repo, 'notes', 'new.txt'), 'utf8'), 'new work not captured');
});

test('snapshot manifests require valid recovery fields, not merely version 1', () => {
  const valid = { version: 1, repoRoot: path.resolve('repo'), label: 'run', createdAt: 1, modifiedTracked: ['work.ts'], untracked: [] };
  assert.equal(isSupportedSnapshotManifest(valid), true);
  for (const invalid of [
    { version: 1 },
    { ...valid, repoRoot: 123 },
    { ...valid, modifiedTracked: {} },
    { ...valid, untracked: [null] },
    { ...valid, createdAt: null },
  ]) assert.equal(isSupportedSnapshotManifest(invalid), false);
});

test('same-millisecond snapshots never share a payload directory', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
  const first = await createSnapshotDirectory(repo, 'run');
  const second = await createSnapshotDirectory(repo, 'run');
  assert.notEqual(first, second);
});
