import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyQaVerdict,
  applyRecordedQaVerdict,
  forgetQaRun,
  markQaRunDone,
  recordQaRun,
  recordQaVerdict,
} from '../qaRuns.js';
import { recoverTaskIfBranchWasDeleted } from '../recovery/index.js';
import { stampTimestamps } from '../taskCache/taskUpdate.js';
import { createTask, getTask, updateTask, type Task } from '../tasks.js';

// Regression: the QA verdict guard (qaRuns/verdict.ts) only promotes a task
// whose `mergedAt` predates the QA run — it relies on every landing in QA
// re-stamping `mergedAt`. Boot recovery of a ready_to_merge task whose branch
// was already deleted (a merge that died before finalize wrote the status)
// kept the OLD `mergedAt`, so a PASS recorded by a QA run of the previous build
// promoted the reworked, untested build to Done.

test('boot recovery re-stamps mergedAt, so a stale QA PASS cannot promote the reworked build', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'lattice-stale-mergedat-'));
  const runId = 'qa_stale_mergedat_recovery';
  try {
    execFileSync('git', ['init', '-q'], { cwd: project });
    const created = await createTask(project, 'reworked after QA');
    // Re-merged after rework, but the backend died after the branch was
    // deleted and before finalize wrote `qa`.
    await updateTask(created.id, { status: 'ready_to_merge', mergedAt: 1000, branch: 'x' });
    recordQaRun({
      id: runId,
      taskId: created.id,
      projectPath: created.projectPath,
      cwd: path.join(project, 'scratch'),
      status: 'running',
      createdAt: 2000,
    });
    recordQaVerdict(runId, { passed: true, confident: true, receivedAt: 2500 });

    const task = await getTask(created.id);
    assert.ok(task);
    await recoverTaskIfBranchWasDeleted(task);
    const recovered = await getTask(created.id);
    assert.equal(recovered?.status, 'qa');
    assert.ok((recovered?.mergedAt ?? 0) > 2000, 'recovery stamps a fresh mergedAt');

    const outcome = await applyRecordedQaVerdict(runId);
    assert.equal(outcome.moved, false);
    assert.equal((await getTask(created.id))?.status, 'qa');
  } finally {
    markQaRunDone(runId);
    forgetQaRun(runId);
    await rm(project, { recursive: true, force: true });
  }
});

test('a task dragged out of QA loses its mergedAt, so the next merge re-stamps it', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'lattice-stale-mergedat-lane-'));
  const runId = 'qa_stale_mergedat_lane';
  try {
    const created = await createTask(project, 'dragged back for rework');
    await updateTask(created.id, { status: 'qa', mergedAt: 1000 });
    recordQaRun({
      id: runId,
      taskId: created.id,
      projectPath: created.projectPath,
      cwd: path.join(project, 'scratch'),
      status: 'running',
      createdAt: 2000,
    });
    await updateTask(created.id, { status: 'in_progress' });
    assert.equal((await getTask(created.id))?.mergedAt, undefined);
    // The PASS lands while the task is out of QA: recorded, not applied.
    assert.equal((await applyQaVerdict(runId, { passed: true, confident: true })).moved, false);

    // A plain status flip into QA (no explicit mergedAt) re-stamps it.
    await updateTask(created.id, { status: 'ready_to_merge' });
    await updateTask(created.id, { status: 'qa' });
    assert.ok(((await getTask(created.id))?.mergedAt ?? 0) > 2000);
    assert.equal((await applyRecordedQaVerdict(runId)).moved, false);
    assert.equal((await getTask(created.id))?.status, 'qa');
  } finally {
    markQaRunDone(runId);
    forgetQaRun(runId);
    await rm(project, { recursive: true, force: true });
  }
});

test('stampTimestamps: clears mergedAt only when moving back to a pre-merge lane', () => {
  const inQa: Task = { id: 't', projectPath: 'C:/p', title: 't', status: 'qa', createdAt: 1, mergedAt: 1000 };
  for (const status of ['backlog', 'open', 'in_progress', 'ready_to_merge'] as const) {
    const out = stampTimestamps(inQa, { status });
    assert.ok('mergedAt' in out && out.mergedAt === undefined, `cleared on qa → ${status}`);
  }
  assert.ok(!('mergedAt' in stampTimestamps(inQa, { status: 'done' })), 'kept on qa → done');
  assert.ok(!('mergedAt' in stampTimestamps(inQa, { status: 'deleted' })), 'kept on qa → deleted');
  assert.ok(!('mergedAt' in stampTimestamps(inQa, { title: 'renamed' })), 'kept without a status change');
  assert.equal(
    stampTimestamps(inQa, { status: 'ready_to_merge', mergedAt: 5 }).mergedAt,
    5,
    'an explicit mergedAt wins',
  );
});
