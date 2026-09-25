import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resumeInterruptedMergeRuns } from '../recovery/mergeRunResume.js';
import { fireOwedPostMergeHooks } from '../recovery/owedPostMergeHooks.js';
import { inspectProjectRunLock } from '../projectRunLock.js';
import { projectRunLockFilePath } from '../projectRunLock/paths.js';
import type { LockBody } from '../projectRunLock/types.js';
import { clearPostMergeHookOwed, isPostMergeHookOwed, markPostMergeHookOwed } from '../postMergeHooks/owed.js';
import { patchUserSettings } from '../userSettings.js';
import { canonicalProjectPath } from '../projectPath.js';
import { createTask, deleteTask, flushPersist, updateTask } from '../tasks.js';
import type { MergeRun } from '../mergeRuns/state.js';
import type { startMergeRun as realStartMergeRun } from '../mergeRuns.js';

// Regression for: "on boot, an owed post-merge hook raced the resumed merge
// run." The backend died mid merge-all with some tasks already in QA (owed
// marker set) and some still ready_to_merge. `resumeInterruptedMergeRuns` fired
// `startMergeRun` without awaiting it, and `startMergeRun` registers the run
// only after several awaits (project load, stealing the dead lock, loading
// targets, the recovery budget) — so `fireOwedPostMergeHooks`, which runs next,
// saw no active run and started hook H on the main checkout beside the resumed
// run. The run's preflight then snapshotted/reset the tree under H's edits, and
// its teardown fired a second hook H2 for the same merges.

const ORIGIN = 'http://127.0.0.1:1';

async function makeProject(t: { after: (fn: () => Promise<void>) => void }, label: string) {
  assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'refusing to touch the real ~/.lattice — run via npm test');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `lattice-owed-${label}-`));
  const projectPath = path.join(base, 'repo');
  await fs.mkdir(projectPath, { recursive: true });
  // Registers the project in the (isolated) ~/.lattice/projects.json index.
  const task = await createTask(projectPath, 'owed hook fixture');
  await updateTask(task.id, { status: 'ready_to_merge' });
  await flushPersist(projectPath);
  await patchUserSettings(projectPath, { postMergeHookPrompt: 'run the checks' });
  await markPostMergeHookOwed(projectPath);
  assert.equal(await isPostMergeHookOwed(projectPath), true);
  const lockFile = projectRunLockFilePath(projectPath);
  t.after(async () => {
    await deleteTask(task.id).catch(() => undefined);
    await clearPostMergeHookOwed(projectPath);
    await fs.rm(lockFile, { force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
  return { projectPath, lockFile };
}

async function writeLock(lockFile: string, body: LockBody): Promise<void> {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  await fs.writeFile(lockFile, JSON.stringify(body, null, 2), 'utf8');
}

const sameProject = (a: string, b: string) => canonicalProjectPath(a) === canonicalProjectPath(b);

test('boot skips the owed hook for a project whose merge run it just resumed', async (t) => {
  const { projectPath, lockFile } = await makeProject(t, 'resume');
  await writeLock(lockFile, {
    pid: -1,
    hostname: os.hostname(),
    startedAt: Date.now() - 60_000,
    label: 'merge-run',
    ownerId: 'dead-gen',
  });

  // Mirrors the real `startMergeRun`: the dead lock is stolen first, and the
  // run is registered only after further awaits. (Stealing it is what makes
  // this a test of the await, not of the run-lock backstop.)
  let registered = false;
  let starts = 0;
  const startMergeRun = (async (repoRoot: string) => {
    if (!sameProject(repoRoot, projectPath)) throw new Error('not this test\'s project');
    starts += 1;
    await fs.rm(lockFile, { force: true });
    await new Promise((r) => setTimeout(r, 30));
    registered = true;
    return { id: 'mr_resumed', projectPath: repoRoot, status: 'running' } as MergeRun;
  }) as unknown as typeof realStartMergeRun;

  await resumeInterruptedMergeRuns(ORIGIN, { startMergeRun });
  assert.equal(starts, 1, 'the interrupted merge run was resumed');

  const fired: string[] = [];
  await fireOwedPostMergeHooks(ORIGIN, {
    getActiveRunForProject: (p) =>
      registered && sameProject(p, projectPath) ? ({ id: 'mr_resumed' } as MergeRun) : null,
    inspectProjectRunLock,
    runPostMergeHookGate: async (options) => {
      if (sameProject(options.projectPath, projectPath)) fired.push(options.projectPath);
      return null;
    },
  });

  assert.deepEqual(fired, [], 'the resumed run\'s teardown fires the owed hook — boot must not');
  assert.equal(await isPostMergeHookOwed(projectPath), true, 'the debt is left for that teardown');
});

test('boot skips the owed hook while the project run lock is held or stale-resumable', async (t) => {
  const { projectPath, lockFile } = await makeProject(t, 'lock');
  const fired: string[] = [];
  const deps = {
    getActiveRunForProject: () => null,
    inspectProjectRunLock,
    runPostMergeHookGate: async (options: { projectPath: string }) => {
      if (sameProject(options.projectPath, projectPath)) fired.push(options.projectPath);
      return null;
    },
  };

  // A live holder: a merge is in flight somewhere.
  await writeLock(lockFile, {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
    label: 'merge-run',
    ownerId: 'live-gen',
  });
  await fireOwedPostMergeHooks(ORIGIN, deps);
  assert.deepEqual(fired, [], 'a held run lock defers the owed hook');

  // A dead merge-run lock the resume did not (or failed to) pick up.
  await writeLock(lockFile, {
    pid: -1,
    hostname: os.hostname(),
    startedAt: Date.now() - 60_000,
    label: 'merge-run',
    ownerId: 'dead-gen',
  });
  await fireOwedPostMergeHooks(ORIGIN, deps);
  assert.deepEqual(fired, [], 'a stale resumable run lock defers the owed hook');

  // A dead lock that is NOT a resumable merge (a manual /merge) is no merge in
  // flight: nothing else will fire the hook, so boot does.
  await writeLock(lockFile, {
    pid: -1,
    hostname: os.hostname(),
    startedAt: Date.now() - 60_000,
    label: 'manual-merge',
    ownerId: 'dead-manual',
  });
  await fireOwedPostMergeHooks(ORIGIN, deps);
  assert.equal(fired.length, 1, 'a non-resumable stale lock does not block the owed hook');

  // No lock at all: fired.
  await fs.rm(lockFile, { force: true });
  await fireOwedPostMergeHooks(ORIGIN, deps);
  assert.equal(fired.length, 2);
});
