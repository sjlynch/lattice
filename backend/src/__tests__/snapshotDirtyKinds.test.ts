import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  copyDirtyPathsToSnapshot,
  resetTrackedSnapshotPaths,
  snapshotWorkingTree,
} from '../worktree/snapshot/capture.js';
import { readSnapshotManifest, snapshotManifestPath } from '../worktree/snapshot/manifest.js';
import { restoreSnapshot } from '../worktree/snapshot/restore.js';

// Real-git regression for the snapshot's dirty-path classification.
//
// `git status` used to be read as two buckets — `??` untracked, everything
// else "modified" — and the modified reset was ONE `git checkout HEAD --
// :(literal)a :(literal)b …`. A staged-new file (`A `) is not in HEAD, git
// validates every pathspec before touching anything, so that one entry made
// the whole checkout exit 1 and every genuinely modified file in the batch
// stayed dirty; the fast-forward that followed then failed with "local
// changes would be overwritten" for EVERY task in the run. A locally deleted
// tracked file (` D`/`D `) failed the same way from the other side: its copy
// hit ENOENT, it was left out of the reset set, and the FF refused on the
// local deletion. Both now have their own bucket + cleanup + restore.

const exists = (p: string) => fs.access(p).then(() => true, () => false);
const lf = (s: string) => s.replace(/\r\n/g, '\n');

async function repoFixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-kinds-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'committed base\n');
  await fs.writeFile(path.join(repo, 'gone.txt'), 'to be deleted\n');
  await fs.writeFile(path.join(repo, 'staged-gone.txt'), 'to be git-rm-ed\n');
  await fs.writeFile(path.join(repo, 'moved.txt'), 'to be renamed\n');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' }).toString();
  git('init', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
  const status = () => git('status', '--porcelain');
  return { root, repo, git, status };
}

test('a staged-new, a modified and two deleted paths are captured together, leave a clean tree, and round-trip', async (t) => {
  const { repo, git, status } = await repoFixture(t);
  await fs.writeFile(path.join(repo, 'new.txt'), 'brand new\n');
  git('add', '--', 'new.txt'); // `A ` — in the index, not in HEAD
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'edited\n'); // ` M`
  await fs.rm(path.join(repo, 'gone.txt')); // ` D`
  git('rm', '-q', '--', 'staged-gone.txt'); // `D `

  const snapshot = await snapshotWorkingTree(repo, 'test');

  assert.equal(status().trim(), '', `working tree must be clean after capture, got:\n${status()}`);
  assert.equal(lf(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8')), 'committed base\n');
  assert.equal(await exists(path.join(repo, 'new.txt')), false, 'the staged-new working copy is removed after capture');
  assert.equal(await exists(path.join(repo, 'gone.txt')), true, 'a deleted tracked file is resurrected from HEAD');
  assert.equal(await exists(path.join(repo, 'staged-gone.txt')), true);

  const manifest = await readSnapshotManifest(snapshotManifestPath(snapshot.dir));
  assert.ok(manifest);
  assert.deepEqual(manifest.modifiedTracked, ['tracked.txt']);
  assert.deepEqual(manifest.untracked, ['new.txt'], 'a staged-new path is listed as an untracked copy');
  assert.deepEqual([...(manifest.deleted ?? [])].sort(), ['gone.txt', 'staged-gone.txt']);
  assert.equal(await fs.readFile(path.join(snapshot.dir, 'new.txt'), 'utf8'), 'brand new\n');

  const result = await restoreSnapshot(snapshot, repo);
  assert.equal(result.status, 'restored', JSON.stringify(result));
  assert.equal(result.retained, false);
  assert.equal(await fs.readFile(path.join(repo, 'new.txt'), 'utf8'), 'brand new\n');
  assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'edited\n');
  assert.equal(await exists(path.join(repo, 'gone.txt')), false, 'the deletion is re-applied on restore');
  assert.equal(await exists(path.join(repo, 'staged-gone.txt')), false);
  const lines = status().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort();
  assert.deepEqual(lines, ['?? new.txt', 'D gone.txt', 'D staged-gone.txt', 'M tracked.txt']);
});

test('a staged rename round-trips as its destination plus the deleted source', async (t) => {
  const { repo, git, status } = await repoFixture(t);
  git('mv', '--', 'moved.txt', 'renamed.txt'); // `R  renamed.txt\0moved.txt`

  const snapshot = await snapshotWorkingTree(repo, 'test');
  assert.equal(status().trim(), '', `working tree must be clean after capture, got:\n${status()}`);
  assert.equal(await exists(path.join(repo, 'moved.txt')), true);
  assert.equal(await exists(path.join(repo, 'renamed.txt')), false);

  const result = await restoreSnapshot(snapshot, repo);
  assert.equal(result.status, 'restored', JSON.stringify(result));
  assert.equal(lf(await fs.readFile(path.join(repo, 'renamed.txt'), 'utf8')), 'to be renamed\n');
  assert.equal(await exists(path.join(repo, 'moved.txt')), false);
});

test('restore keeps a file re-created at a captured deletion when it no longer matches HEAD', async (t) => {
  const { repo } = await repoFixture(t);
  await fs.rm(path.join(repo, 'gone.txt'));
  const snapshot = await snapshotWorkingTree(repo, 'test');
  assert.equal(await exists(path.join(repo, 'gone.txt')), true);
  // The user (or the fast-forward) put different content there since.
  await fs.writeFile(path.join(repo, 'gone.txt'), 'newer work\n');

  const result = await restoreSnapshot(snapshot, repo);
  assert.equal(result.status, 'partial');
  assert.equal(result.retained, true);
  assert.equal(result.failed[0]?.file, 'gone.txt');
  assert.equal(await fs.readFile(path.join(repo, 'gone.txt'), 'utf8'), 'newer work\n');
  await fs.access(snapshot.dir);
});

test('the tracked reset survives one pathspec git does not know (per-path retry)', async (t) => {
  const { root, repo } = await repoFixture(t);
  const snapshotDir = path.join(root, 'snapshot');
  await fs.mkdir(snapshotDir);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'edited\n');
  // Not in HEAD — `git checkout HEAD -- :(literal)orphan.txt` refuses, and
  // with it (pre-fix) the whole batch, leaving tracked.txt dirty.
  await fs.writeFile(path.join(repo, 'orphan.txt'), 'x\n');
  const copied = await copyDirtyPathsToSnapshot(repo, snapshotDir, {
    modified: ['tracked.txt', 'orphan.txt'],
    untracked: [],
  });
  assert.deepEqual(copied.copiedModified, ['tracked.txt', 'orphan.txt']);

  await resetTrackedSnapshotPaths(repo, copied.copiedModified, snapshotDir);

  assert.equal(lf(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8')), 'committed base\n',
    'the known path is reset even though a sibling pathspec was rejected');
  assert.equal(await fs.readFile(path.join(repo, 'orphan.txt'), 'utf8'), 'x\n', 'the rejected path is left alone');
});
