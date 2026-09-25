import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotWorkingTree } from '../worktree/snapshot/capture.js';
import { readSnapshotManifest, snapshotManifestPath } from '../worktree/snapshot/manifest.js';
import { restoreSnapshot } from '../worktree/snapshot/restore.js';
import { recoverPendingSnapshots } from '../worktree/snapshot/recovery.js';
import { resumeInterruptedMergeRuns } from '../recovery/mergeRunResume.js';
import { fireOwedPostMergeHooks } from '../recovery/owedPostMergeHooks.js';
import { inspectProjectRunLock } from '../projectRunLock.js';
import { projectRunLockFilePath } from '../projectRunLock/paths.js';
import { clearInterruptedRun, readInterruptedRun } from '../projectRunLock/interruptedRun.js';
import { clearPostMergeHookOwed, markPostMergeHookOwed } from '../postMergeHooks/owed.js';
import { patchUserSettings } from '../userSettings.js';
import { canonicalProjectPath } from '../projectPath.js';
import { createTask, deleteTask, flushPersist, updateTask } from '../tasks.js';
import type { MergeRun } from '../mergeRuns/state.js';
import type { startMergeRun as realStartMergeRun } from '../mergeRuns.js';

const ORIGIN = 'http://127.0.0.1:1';

async function repoFixture(t: { after: (fn: () => Promise<unknown>) => void }, label: string) {
  assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'refusing to touch the real ~/.lattice — run via npm test');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `lattice-snap-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'committed base\n');
  git('add', '--', 'tracked.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
  return { repo };
}

// Bug 2: once a restore went `partial`, the snapshot kept its full manifest and
// every later boot re-applied ALL of it — a restored file the user had since
// deleted came back, and a reviewed-and-deleted `.lattice-conflict` copy was
// re-created, on every restart.
test('a partially restored snapshot is not re-applied on the next boot', async (t) => {
  const { repo } = await repoFixture(t, 'partial');
  const tracked = path.join(repo, 'tracked.txt');
  const restoredFile = path.join(repo, 'notes.txt');
  await fs.writeFile(tracked, 'captured edits\n');
  await fs.writeFile(restoredFile, 'captured notes\n');
  const snapshot = await snapshotWorkingTree(repo, 'test');
  // A newer edit while the snapshot was out: that path conflicts on restore.
  await fs.writeFile(tracked, 'newer user edits\n');

  const result = await restoreSnapshot(snapshot, repo);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.restored, ['notes.txt']);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].file, 'tracked.txt');
  const manifest = await readSnapshotManifest(snapshotManifestPath(snapshot.dir));
  assert.equal(manifest?.archived, true, 'nothing left to retry: kept only as an archive');
  assert.deepEqual([...manifest!.modifiedTracked, ...manifest!.untracked], []);

  // The user reviews: drops the restored file and the conflict copy.
  await fs.rm(restoredFile);
  await fs.rm(result.conflicts[0].backupPath);

  await recoverPendingSnapshots();

  await assert.rejects(fs.access(restoredFile), { code: 'ENOENT' }, 'the deleted restored file stays deleted');
  await assert.rejects(fs.access(result.conflicts[0].backupPath), { code: 'ENOENT' }, 'no fresh conflict copy');
  assert.equal(await fs.readFile(tracked, 'utf8'), 'newer user edits\n');
  await fs.access(snapshot.dir); // the captured payload is still kept for the user
});

test('a partial restore keeps only the paths that can still succeed pending', async (t) => {
  const { repo } = await repoFixture(t, 'narrow');
  await fs.writeFile(path.join(repo, 'notes.txt'), 'captured notes\n');
  await fs.mkdir(path.join(repo, 'pkg'));
  await fs.writeFile(path.join(repo, 'pkg', 'wip.ts'), 'captured wip\n');
  const snapshot = await snapshotWorkingTree(repo, 'test');
  // A FILE now sits where pkg/ was: pkg/wip.ts cannot be written back yet.
  await fs.rm(path.join(repo, 'pkg'), { recursive: true });
  await fs.writeFile(path.join(repo, 'pkg'), 'a file in the way');

  const result = await restoreSnapshot(snapshot, repo);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.restored, ['notes.txt']);
  assert.deepEqual(result.failed.map((f) => f.file), ['pkg/wip.ts']);
  const manifest = await readSnapshotManifest(snapshotManifestPath(snapshot.dir));
  assert.equal(manifest?.archived, undefined);
  assert.deepEqual(manifest?.untracked, ['pkg/wip.ts'], 'only the failed path stays pending');

  // Once the obstacle is gone, boot recovery restores just that path.
  await fs.rm(path.join(repo, 'notes.txt'));
  await fs.rm(path.join(repo, 'pkg'));
  await recoverPendingSnapshots();
  assert.equal(await fs.readFile(path.join(repo, 'pkg', 'wip.ts'), 'utf8'), 'captured wip\n');
  await assert.rejects(fs.access(path.join(repo, 'notes.txt')), { code: 'ENOENT' }, 'the settled path is not re-applied');
  await assert.rejects(fs.access(snapshot.dir), { code: 'ENOENT' }, 'fully restored now: removed');
});

// Bug 1: boot snapshot recovery acquires the project run lock to restore a
// pending snapshot, stealing and retiring an interrupted Merge All's dead
// `merge-run` lock. The merge-run resume, which runs next, then found no lock
// and left the ready_to_merge tasks stranded; the owed post-merge hook check
// stopped seeing the interrupted merge too.
test('an interrupted Merge All still resumes after snapshot recovery retired its dead lock', async (t) => {
  const { repo } = await repoFixture(t, 'resume');
  const lockFile = projectRunLockFilePath(repo);
  // The run's snapshot of the user's dirty work, still pending.
  await fs.writeFile(path.join(repo, 'notes.txt'), 'irreplaceable notes\n');
  const snapshot = await snapshotWorkingTree(repo, 'run');
  await assert.rejects(fs.access(path.join(repo, 'notes.txt')), { code: 'ENOENT' });
  // One task still waiting to merge (also registers the project).
  const task = await createTask(repo, 'interrupted merge fixture');
  await updateTask(task.id, { status: 'ready_to_merge' });
  await flushPersist(repo);
  await patchUserSettings(repo, { postMergeHookPrompt: 'run the checks' });
  await markPostMergeHookOwed(repo);
  t.after(async () => {
    await deleteTask(task.id).catch(() => undefined);
    await clearPostMergeHookOwed(repo);
    await clearInterruptedRun(repo);
    await fs.rm(lockFile, { force: true });
  });
  // The Merge All's lock, left behind by the killed backend.
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  await fs.writeFile(lockFile, JSON.stringify({
    pid: -1,
    hostname: os.hostname(),
    startedAt: Date.now() - 60_000,
    label: 'merge-run',
    ownerId: 'dead-gen',
  }, null, 2), 'utf8');

  // --- the startup recovery chain ---
  await recoverPendingSnapshots();
  assert.equal(await fs.readFile(path.join(repo, 'notes.txt'), 'utf8'), 'irreplaceable notes\n');
  await assert.rejects(fs.access(snapshot.dir), { code: 'ENOENT' });
  assert.equal(await inspectProjectRunLock(repo), null, 'recovery retired the dead lock');
  assert.equal((await readInterruptedRun(repo))?.label, 'merge-run', '…and recorded it first');

  // The owed hook must not fire while that merge is still to resume.
  const sameProject = (p: string) => canonicalProjectPath(p) === canonicalProjectPath(repo);
  const fired: string[] = [];
  await fireOwedPostMergeHooks(ORIGIN, {
    getActiveRunForProject: () => null,
    inspectProjectRunLock,
    runPostMergeHookGate: async (options) => {
      if (sameProject(options.projectPath)) fired.push(options.projectPath);
      return null;
    },
  });
  assert.deepEqual(fired, [], 'the interrupted merge fires the owed hook, not boot');

  const started: string[] = [];
  const startMergeRun = (async (repoRoot: string) => {
    if (!sameProject(repoRoot)) throw new Error('not this test\'s project');
    started.push(repoRoot);
    return { id: 'mr_resumed', projectPath: repoRoot, status: 'running' } as MergeRun;
  }) as unknown as typeof realStartMergeRun;
  await resumeInterruptedMergeRuns(ORIGIN, { startMergeRun });

  assert.equal(started.length, 1, 'the interrupted merge run was resumed');
  assert.equal(await readInterruptedRun(repo), null, 'the marker is cleared once the run started');
});
