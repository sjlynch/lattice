import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isResumableInterruptedRunLock, resumeInterruptedMergeRuns } from '../recovery/mergeRunResume.js';
import { readLockBody } from '../projectRunLock/lockfile.js';
import { projectRunLockFilePath } from '../projectRunLock/paths.js';
import type { LockBody } from '../projectRunLock/types.js';
import { createTask, deleteTask, flushPersist, updateTask } from '../tasks.js';

// Regression for: "a start → merge → push workflow whose Merge control step was
// killed by a backend restart/crash left its tasks stranded in ready_to_merge
// (never merged), while the next queued workflow started on top." Boot recovery
// resumes a killed `merge-run` lock, but the workflow Merge step holds a
// `workflow-merge:<runId>` lock — which the old label check skipped, so the
// orphaned tasks were never drained.

test('resumes a stale workflow Merge control-step lock', () => {
  assert.equal(isResumableInterruptedRunLock('workflow-merge:wfrun_123_abc'), true);
});

test('resumes a stale workflow Push control-step lock', () => {
  assert.equal(isResumableInterruptedRunLock('workflow-push:wfrun_123_abc'), true);
});

test('still resumes a stale backend merge-run lock (unchanged)', () => {
  assert.equal(isResumableInterruptedRunLock('merge-run'), true);
});

test('does NOT resume a manual /merge lock', () => {
  // A single-task manual merge is not a run; it has its own recovery.
  assert.equal(isResumableInterruptedRunLock('manual-merge'), false);
});

test('does NOT resume a workflow Start lock', () => {
  // Start dies before tasks reach ready_to_merge; its orphans are in_progress
  // and handled by the in-progress sweep, not a merge resume.
  assert.equal(isResumableInterruptedRunLock('workflow-start:wfrun_123_abc'), false);
});

// ---- a dead lock with nothing to resume is retired, not left behind ----------
//
// Nothing ever acquires (and so steals) a stale run.lock on a project with no
// pending ready_to_merge work, so it outlived every boot that logged it — and
// once the OS recycled its PID, the dev runner's restart deferral read it as a
// live operation for the full 15-min backstop (2026-09-22).

test('resumeInterruptedMergeRuns retires a dead merge-run lock when no ready_to_merge work remains', async (t) => {
  assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'refusing to touch the real ~/.lattice — run via npm test');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-stale-lock-'));
  const projectPath = path.join(base, 'repo');
  await fs.mkdir(projectPath, { recursive: true });
  // Registers the project in the (isolated) ~/.lattice/projects.json index.
  const task = await createTask(projectPath, 'stale lock fixture');
  await updateTask(task.id, { status: 'done' });
  await flushPersist(projectPath);
  const lockFile = projectRunLockFilePath(projectPath);
  t.after(async () => {
    await deleteTask(task.id).catch(() => undefined);
    await fs.rm(path.dirname(lockFile), { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });

  const dead: LockBody = { pid: -1, hostname: os.hostname(), startedAt: Date.now() - 60_000, label: 'merge-run', ownerId: 'dead-gen' };
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  await fs.writeFile(lockFile, JSON.stringify(dead, null, 2), 'utf8');

  await resumeInterruptedMergeRuns('http://127.0.0.1:1');
  assert.equal(await readLockBody(lockFile), null, 'the dead lock is gone');
  await assert.rejects(fs.access(lockFile), 'the lockfile itself was unlinked');
  const tombstones = await fs.readdir(`${lockFile}.retired`);
  assert.equal(tombstones.length, 1, 'retired through the tombstone protocol, not a raw unlink');

  // A LIVE holder is left alone (the existing "owner still alive" path).
  const live: LockBody = { pid: process.pid, hostname: os.hostname(), startedAt: Date.now(), label: 'merge-run', ownerId: 'live-gen' };
  await fs.writeFile(lockFile, JSON.stringify(live, null, 2), 'utf8');
  await resumeInterruptedMergeRuns('http://127.0.0.1:1');
  assert.equal((await readLockBody(lockFile))?.ownerId, 'live-gen', 'a live lock is never retired');
});
