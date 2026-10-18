// Completion and boot recovery share one per-head review flight. Later heads
// must run serially and interrupted rerun intent must survive backend restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createTask, getTask, updateTaskCrashSafe } from '../tasks.js';
import { patchUserSettings } from '../userSettings.js';
import { beginTaskReview, resumeTaskReview } from '../taskReview/service.js';
import type { ReviewResult } from '../taskReview/runner.js';
import { resumeInterruptedTaskReviews } from '../recovery/taskReviewResume.js';
import { handleTaskComplete } from '../routes/tasks/hooks/complete.js';
import { withTempDir } from './helpers/tempDir.js';
import { HEAD, verdict, deps, fixture, onDisk, waitFor } from './helpers/taskReview.js';

test('/complete with review on holds In Progress, persists reviewing and dedupes concurrent calls per head', async () => {
  await withTempDir('review-complete-', async (project) => {
    const task = await createTask(project, 'Finish me');
    await patchUserSettings(project, { taskReview: 'flag' });
    await updateTaskCrashSafe(task.id, { status: 'in_progress' });
    let finish!: (value: ReviewResult) => void;
    let calls = 0;
    const seam = deps({ run: async () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
    const handler = handleTaskComplete('origin', (task, origin) => beginTaskReview(task, origin, seam));
    const call = async () => {
      let body: unknown;
      const req = { params: { id: task.id }, query: {} } as unknown as Request<{ id: string }>;
      const res = { json: (value: unknown) => { body = value; return res; } } as Response;
      await handler(req, res);
      return body;
    };
    const responses = await Promise.all([call(), call()]);
    assert.ok(responses.some((response) => JSON.stringify(response) === '{"ok":true,"reviewing":true}'));
    assert.ok(responses.some((response) => JSON.stringify(response) === '{"ok":true}'));
    const saved = await onDisk(task);
    assert.equal(saved.status, 'in_progress');
    assert.equal(saved.review?.status, 'reviewing');
    assert.equal(saved.review?.head, HEAD);
    await waitFor(async () => calls === 1);
    assert.deepEqual(await call(), { ok: true });
    finish({ ...verdict, verdict: 'accept' });
    await waitFor(async () => (await getTask(task.id))?.status === 'ready_to_merge');
    assert.deepEqual(await call(), { ok: true });
    assert.equal(calls, 1);
  });
});

test('new head during a review is reviewed serially and the earlier verdict is discarded', async () => {
  await withTempDir('review-new-head-', async (project) => {
    const task = await createTask(project, 'Finish me');
    await updateTaskCrashSafe(task.id, { status: 'in_progress' });
    await patchUserSettings(project, { taskReview: 'flag' });
    let head = HEAD;
    const finishes: ((value: ReviewResult) => void)[] = [];
    const seam = deps({ head: async () => head,
      run: async () => new Promise((resolve) => finishes.push(resolve)),
    });
    assert.equal(await beginTaskReview((await getTask(task.id))!, 'origin', seam), 'reviewing');
    await waitFor(async () => finishes.length === 1);
    head = 'b'.repeat(40);
    assert.equal(await beginTaskReview((await getTask(task.id))!, 'origin', seam), 'reviewing');
    finishes[0](verdict);
    await waitFor(async () => finishes.length === 2);
    assert.equal((await getTask(task.id))?.status, 'in_progress');
    finishes[1]({ ...verdict, verdict: 'accept' });
    await waitFor(async () => (await getTask(task.id))?.status === 'ready_to_merge');
    assert.equal((await getTask(task.id))?.review?.head, head);
    assert.equal((await getTask(task.id))?.summary, undefined, 'stale rejection never appends a warning');
  });
});

test('boot resumes only in-progress reviews and durable rerun intents, and recovery dedupes the CLI', async () => {
  await withTempDir('review-recovery-', async (project) => {
    const task = await fixture(project);
    const skipped = { ...task, id: 'other', status: 'open' as const };
    let runs = 0;
    let finish!: (value: ReviewResult) => void;
    const seam = deps({ run: async () => { runs++; return new Promise((resolve) => { finish = resolve; }); } });
    const recover = () => resumeInterruptedTaskReviews('origin', {
      forEachProject: async (_label, fn) => fn(project), listTasks: async () => [task, skipped],
      resume: (task, origin) => resumeTaskReview(task, origin, seam),
    });
    await recover(); await recover();
    await waitFor(async () => runs === 1);
    finish({ ...verdict, verdict: 'accept' });
    await waitFor(async () => (await getTask(task.id))?.status === 'ready_to_merge');
    const pending = await fixture(project, 2);
    const intent = (await updateTaskCrashSafe(pending.id, {
      review: { ...pending.review!, status: 'rerun', keptBranch: `${pending.branch}-attempt-1`, rerunPending: true }, runQueuedHarness: 'codex', runQueuedModel: 'strong',
    }))!;
    resumeTaskReview(intent, 'origin', deps({ enqueue: async (queued) => { assert.equal(queued.runQueuedModel, 'strong'); } }));
    await waitFor(async () => (await getTask(intent.id))?.status === 'open');
    assert.equal((await onDisk(intent)).runQueued, true);
  });
});

