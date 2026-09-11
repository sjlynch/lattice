import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireProjectRunLock, inspectProjectRunLock } from '../projectRunLock.js';
import { snapshotWorkingTree, copyDirtyPathsToSnapshot, resetTrackedSnapshotPaths, cleanupCapturedUntrackedPaths } from '../worktree/snapshot/capture.js';
import { readSnapshotManifest, snapshotManifestPath } from '../worktree/snapshot/manifest.js';
import { restoreSnapshot } from '../worktree/snapshot/restore.js';
import { recoverPendingSnapshots } from '../worktree/snapshot/recovery.js';
import { finalizeMergedTask } from '../worktree/finalize.js';
import type { Task } from '../tasks.js';

async function repoFixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-owner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'committed base\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('add', '--', 'tracked.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
  return { root, repo, git };
}

test('in-session restoration restores captured work over clean HEAD', async (t) => {
  const { repo } = await repoFixture(t);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'captured edits\n');
  const snapshot = await snapshotWorkingTree(repo, 'test');
  assert.equal((await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'committed base\n');
  const result = await restoreSnapshot(snapshot, repo);
  assert.equal(result.status, 'restored');
  assert.equal(result.retained, false);
  assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'captured edits\n');
});

test('in-session restoration preserves edits made while a merge was running', async (t) => {
  const { repo } = await repoFixture(t);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'captured edits\n');
  const snapshot = await snapshotWorkingTree(repo, 'test');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'newer user edits\n');
  const result = await restoreSnapshot(snapshot, repo);
  assert.equal(result.status, 'partial');
  assert.equal(result.retained, true);
  assert.deepEqual(result.restored, []);
  assert.equal(result.conflicts[0]?.file, 'tracked.txt');
  assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'newer user edits\n');
  assert.equal(await fs.readFile(result.conflicts[0].backupPath, 'utf8'), 'captured edits\n');
});

test('capture cleanup preserves tracked and untracked paths edited after their copy', async (t) => {
  const { root, repo } = await repoFixture(t);
  const snapshot = path.join(root, 'snapshot');
  await fs.mkdir(snapshot);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'captured tracked');
  await fs.writeFile(path.join(repo, 'new.txt'), 'captured new');
  const copied = await copyDirtyPathsToSnapshot(repo, snapshot, { modified: ['tracked.txt'], untracked: ['new.txt'] });
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'newer tracked');
  await fs.writeFile(path.join(repo, 'new.txt'), 'newer new');
  await resetTrackedSnapshotPaths(repo, copied.copiedModified, snapshot);
  await cleanupCapturedUntrackedPaths(repo, copied.copiedUntracked, snapshot);
  assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'newer tracked');
  assert.equal(await fs.readFile(path.join(repo, 'new.txt'), 'utf8'), 'newer new');
});

test('boot recovery defers a live-owned snapshot, then recovers after ownership is released', async (t) => {
  const { repo } = await repoFixture(t);
  await fs.writeFile(path.join(repo, 'untracked.txt'), 'irreplaceable notes');
  const owner = await acquireProjectRunLock(repo, 'merge-run');
  const snapshot = await snapshotWorkingTree(repo, 'run');
  const manifest = await readSnapshotManifest(snapshotManifestPath(snapshot.dir));
  assert.equal(manifest?.owner?.ownerId, (await inspectProjectRunLock(repo))?.holder.ownerId);
  await recoverPendingSnapshots();
  await assert.rejects(fs.access(path.join(repo, 'untracked.txt')), { code: 'ENOENT' });
  await fs.access(snapshot.dir);
  await owner.release();
  await recoverPendingSnapshots();
  assert.equal(await fs.readFile(path.join(repo, 'untracked.txt'), 'utf8'), 'irreplaceable notes');
  await assert.rejects(fs.access(snapshot.dir), { code: 'ENOENT' });
});

test('snapshot partials after a successful fast-forward surface as a finalize error without retry', async (t) => {
  const { root, repo, git } = await repoFixture(t);
  git('checkout', '-b', 'lattice/snapshot-test');
  await fs.writeFile(path.join(repo, 'branch.txt'), 'merged feature');
  git('add', '--', 'branch.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'feature');
  git('checkout', 'main');
  await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '\n.lattice/\nnode_modules/\n');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'captured edits');
  const originalLstat = fs.lstat;
  let reads = 0;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const file = String(args[0]);
    if (file.includes(`${path.sep}snapshots${path.sep}`) && file.endsWith(`${path.sep}tracked.txt`) && ++reads === 2) {
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'newer edits during merge');
    }
    return originalLstat(...args);
  });
  const result = await finalizeMergedTask({ id: 'snapshot-warning', projectPath: repo, title: 'snapshot warning', branch: 'lattice/snapshot-test', worktreePath: path.join(root, 'unused-worktree') } as Task, 'http://unused');
  assert.equal(result.ok, false);
  assert.ok('error' in result);
  assert.match(result.error, /Branch fast-forwarded, but Snapshot partly restored/);
  assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'newer edits during merge');
  assert.equal(await fs.readFile(path.join(repo, 'branch.txt'), 'utf8'), 'merged feature');
});

test('assume-unchanged cannot disguise newer edits as a clean tracked destination', async (t) => {
  const { repo, git } = await repoFixture(t);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'captured edits');
  const snapshot = await snapshotWorkingTree(repo, 'test');
  git('update-index', '--assume-unchanged', '--', 'tracked.txt');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'hidden new edits');
  const result = await restoreSnapshot(snapshot, repo);
  assert.equal(result.status, 'partial');
  assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'hidden new edits');
});
