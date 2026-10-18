// Stale verdicts must not merge withdrawn work; reruns preserve first attempts
// and persist their queue policy before starting a fresh harness conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { Request, Response } from 'express';
import { getTask, updateTask, updateTaskCrashSafe, deleteTask } from '../tasks.js';
import { patchUserSettings } from '../userSettings.js';
import { beginTaskReview, applyReviewResult, resumeTaskReview, isReviewedTaskHead } from '../taskReview/service.js';
import { resumeInterruptedTaskReviews, sweepTaskReviewScratch } from '../recovery/taskReviewResume.js';
import { reviewScratchPaths } from '../taskReview/runner.js';
import { decideAutoComplete } from '../recovery/inProgressSweep/eligibility.js';
import { handleTaskComplete } from '../routes/tasks/hooks/complete.js';
import { enqueueTaskRun } from '../routes/tasks/queuedSpawn.js';
import { withTempDir } from './helpers/tempDir.js';
import { HEAD, verdict, deps, fixture, onDisk, waitFor } from './helpers/taskReview.js';

test('accept and error fail open to Ready to Merge crash-safely', async () => {
  await withTempDir('review-accept-', async (project) => {
    for (const result of [{ ...verdict, verdict: 'accept' as const, p: 99 },
      { verdict: 'error' as const, reason: 'CLI missing', reviewer: verdict.reviewer }]) {
      const task = await fixture(project);
      await applyReviewResult(task, result, { taskReview: 'flag' }, 'origin', deps());
      const saved = await onDisk(task);
      assert.equal(saved.status, 'ready_to_merge');
      assert.equal(saved.review?.status, result.verdict === 'accept' ? 'accepted' : 'error');
      assert.equal(saved.review?.reviewer, verdict.reviewer);
      assert.equal(saved.review?.reason, result.reason);
      assert.ok(saved.review?.finishedAt);
      assert.ok(saved.completedAt);
      assert.equal(saved.summary, task.summary);
    }
  });
});

test('reject+flag, missing rerun harness and attempt 2 flag without a third run', async () => {
  await withTempDir('review-flag-', async (project) => {
    for (const [mode, attempt, harness] of [['flag', 1, 'codex'], ['rerun', 1, undefined], ['rerun', 2, 'codex']] as const) {
      const task = await fixture(project, attempt);
      await applyReviewResult(task, verdict, { taskReview: mode, taskReviewRerunHarness: harness }, 'origin', deps({
        keep: async () => { assert.fail('must not preserve/rerun'); },
        enqueue: async () => { assert.fail('must not enqueue'); },
      }));
      const saved = await onDisk(task);
      assert.equal(saved.status, 'ready_to_merge');
      assert.equal(saved.review?.status, 'rejected');
      assert.equal(saved.review?.p, 25);
      assert.equal(saved.review?.attempt, attempt);
      assert.equal(saved.summary, `Implemented fallback\n\n---\n\nSecond opinion (codex/gpt-6.1-sol): doubtful — Misses missing keys`);
      assert.equal(saved.description, task.description);
    }
  });
});

test('reject+rerun durably keeps work before cleanup and queues a fresh policy, preserving workflow ownership', async () => {
  await withTempDir('review-rerun-', async (project) => {
    const task = await fixture(project);
    const events: string[] = [];
    const policy = { taskReview: 'rerun' as const, taskReviewRerunHarness: 'pi' as const,
      taskReviewRerunPiModel: 'local/strong', taskReviewRerunEffort: 'high' as const };
    await applyReviewResult(task, verdict, policy, 'origin', deps({
      keep: async () => { events.push('keep'); return `${task.branch}-attempt-1`; },
      cleanup: async () => {
        events.push('cleanup');
        const intent = await onDisk(task);
        assert.equal(intent.status, 'in_progress');
        assert.equal(intent.review?.status, 'rerun');
        assert.equal(intent.review?.attempt, 2);
        assert.equal(intent.runQueuedHarness, 'pi');
        return true;
      },
      enqueue: async (queued, origin) => {
        events.push('enqueue');
        assert.equal(origin, 'origin');
        assert.equal((await onDisk(task)).runQueued, true, 'queue intent is on disk before spawn');
        assert.equal(queued.status, 'open');
        assert.equal(queued.branch, undefined);
        assert.equal(queued.worktreePath, undefined);
        assert.equal(queued.runQueuedHarness, 'pi');
        assert.equal(queued.runQueuedPiModel, 'local/strong');
        assert.equal(queued.runQueuedEffort, 'high');
      },
    }));
    assert.deepEqual(events, ['keep', 'cleanup', 'enqueue']);
    const saved = await onDisk(task);
    assert.equal(saved.review?.rerunPending, false, 'running attempt 2 is not pending teardown');
    assert.equal(saved.workflowRunId, 'wf_1');
    assert.equal(saved.workflowStepIndex, 3);
    assert.match(saved.summary!, /Re-running with pi\/local\/strong; the first attempt is on branch lattice\/.*-attempt-1\./);
    // Completion of a fresh run carries attempt 2 into its own review.
    await patchUserSettings(project, { taskReview: 'rerun', taskReviewRerunHarness: 'codex' });
    const started = (await updateTaskCrashSafe(task.id, { status: 'in_progress', branch: 'lattice/fresh' }))!;
    assert.equal(await beginTaskReview(started, 'origin', deps({ head: async () => 'b'.repeat(40), run: async () => verdict })), 'reviewing');
    await waitFor(async () => (await getTask(task.id))?.status === 'ready_to_merge');
    assert.equal((await getTask(task.id))?.review?.attempt, 2);
    assert.equal((await getTask(task.id))?.review?.status, 'rejected');
  });
});

test('stale verdicts are discarded on lane change, away-and-back, head change, branch change and delete', async () => {
  await withTempDir('review-stale-', async (project) => {
    for (const change of ['lane', 'back', 'head', 'branch', 'delete']) {
      const task = await fixture(project);
      if (change === 'lane' || change === 'back') await updateTask(task.id, { status: 'open' });
      if (change === 'back') await updateTask(task.id, { status: 'in_progress' });
      if (change === 'branch') await updateTask(task.id, { branch: 'lattice/other' });
      if (change === 'delete') await deleteTask(task.id);
      const before = await getTask(task.id);
      await applyReviewResult(task, verdict, { taskReview: 'rerun', taskReviewRerunHarness: 'codex' }, 'origin', deps({
        head: async () => change === 'head' ? 'b'.repeat(40) : HEAD,
        keep: async () => { assert.fail(`stale ${change} must not rerun`); },
      }));
      assert.deepEqual(await getTask(task.id), before, change);
    }
  });
});

test('head is rechecked under the task lock before a verdict is applied', async () => {
  await withTempDir('review-head-cas-', async (project) => {
    const task = await fixture(project);
    let reads = 0;
    await applyReviewResult(task, { ...verdict, verdict: 'accept' }, {}, 'origin', deps({
      head: async () => ++reads === 1 ? HEAD : 'b'.repeat(40),
    }));
    assert.equal((await getTask(task.id))?.status, 'in_progress');
  });
});

test('active reviews cannot be bypassed by the dead-PTY sweep, and withdrawn reruns cannot re-enqueue', async () => {
  await withTempDir('review-withdrawal-', async (project) => {
    const task = await fixture(project);
    assert.deepEqual(await decideAutoComplete({ task, liveCwds: new Set(), now: Date.now() }),
      { decision: 'skip', reason: { code: 'review-active' } });
    await updateTask(task.id, { status: 'open', runQueued: false });
    assert.deepEqual(await enqueueTaskRun(task.id, 'origin', 'codex', undefined, {}, { requireQueued: true }), { queued: false });
    assert.equal((await getTask(task.id))?.runQueued, false);
  });
});

test('duplicate reviewed heads acknowledge before the commit-count gate; off still uses the original path', async () => {
  await withTempDir('review-duplicate-head-', async (project) => {
    const task = await fixture(project);
    await updateTaskCrashSafe(task.id, { worktreePath: undefined });
    await patchUserSettings(project, { taskReview: 'flag' });
    assert.equal(await isReviewedTaskHead(task, deps()), true);
    let body: unknown;
    const req = { params: { id: task.id }, query: {} } as unknown as Request<{ id: string }>;
    const res = { json: (value: unknown) => { body = value; return res; } } as Response;
    await handleTaskComplete('origin', async () => { assert.fail('duplicate must not enter admission'); },
      (current) => isReviewedTaskHead(current, deps()))(req, res);
    assert.deepEqual(body, { ok: true });
    await patchUserSettings(project, { taskReview: 'off' });
    assert.equal(await isReviewedTaskHead(task, deps()), false);
  });
});

test('boot never tears down a running second attempt, even when its head equals the first', async () => {
  await withTempDir('review-second-running-', async (project) => {
    const task = await fixture(project, 2);
    const running = (await updateTaskCrashSafe(task.id, { review: { ...task.review!, status: 'rerun',
      keptBranch: `${task.branch}-attempt-1`, rerunPending: false } }))!;
    let recovered = false;
    await resumeInterruptedTaskReviews('origin', {
      forEachProject: async (_label, fn) => fn(project), listTasks: async () => [running],
      resume: () => { recovered = true; },
    });
    assert.equal(recovered, false);
    resumeTaskReview(running, 'origin', deps({ cleanup: async () => { assert.fail('must not tear down running attempt 2'); } }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal((await getTask(task.id))?.status, 'in_progress');
  });
});

test('unsafe checkout cleanup fails open, and lane changes during teardown withdraw the queued run', async () => {
  await withTempDir('review-rerun-cleanup-', async (project) => {
    for (const move of [false, true]) {
      const task = await fixture(project);
      await applyReviewResult(task, verdict, { taskReview: 'rerun', taskReviewRerunHarness: 'codex' }, 'origin', deps({
        cleanup: async () => {
          if (move) await updateTask(task.id, { status: 'backlog' });
          return move;
        }, enqueue: async () => { assert.fail('must not enqueue after failed/withdrawn cleanup'); },
      }));
      const current = await getTask(task.id);
      assert.equal(current?.status, move ? 'backlog' : 'ready_to_merge');
      assert.equal(current?.review?.status, 'error');
      if (move) assert.match(current?.review?.reason ?? '', /withdrawn/);
    }
  });
});

test('withdrawing attempt 2 preserves its retry ceiling when a new head later completes', async () => {
  await withTempDir('review-attempt-ceiling-', async (project) => {
    const task = await fixture(project, 2);
    await updateTask(task.id, { status: 'open' });
    await updateTask(task.id, { status: 'in_progress' });
    await patchUserSettings(project, { taskReview: 'rerun', taskReviewRerunHarness: 'codex' });
    assert.equal((await getTask(task.id))?.review?.attempt, 2);
    await beginTaskReview((await getTask(task.id))!, 'origin', deps({ head: async () => 'b'.repeat(40),
      run: async () => verdict, keep: async () => { assert.fail('must never start attempt 3'); },
    }));
    await waitFor(async () => (await getTask(task.id))?.status === 'ready_to_merge');
    assert.equal((await getTask(task.id))?.review?.status, 'rejected');
    assert.equal((await getTask(task.id))?.review?.attempt, 2);
  });
});

test('admission takes the retry ceiling from the locked task, not an older completion snapshot', async () => {
  await withTempDir('review-admission-ceiling-', async (project) => {
    const oldSnapshot = await fixture(project, 1);
    await updateTaskCrashSafe(oldSnapshot.id, { review: { ...oldSnapshot.review!, attempt: 2 } });
    await patchUserSettings(project, { taskReview: 'rerun', taskReviewRerunHarness: 'codex' });
    await beginTaskReview(oldSnapshot, 'origin', deps({ head: async () => 'b'.repeat(40),
      run: async () => verdict, keep: async () => { assert.fail('must not rerun a stale attempt number'); },
    }));
    await waitFor(async () => (await getTask(oldSnapshot.id))?.status === 'ready_to_merge');
    assert.equal((await getTask(oldSnapshot.id))?.review?.attempt, 2);
    assert.equal((await getTask(oldSnapshot.id))?.review?.status, 'rejected');
  });
});

test('boot scratch cleanup preserves active reviews and reclaims only guarded orphan directories', async () => {
  await withTempDir('review-scratch-sweep-', async (project) => {
    const active = await fixture(project);
    const orphanId = 't_99_orphan';
    const root = reviewScratchPaths.sessionsRoot(project);
    for (const id of [active.id, orphanId]) await fs.mkdir(reviewScratchPaths.assertSafeSessionPath(project, id), { recursive: true });
    const cleaned: string[] = [];
    await sweepTaskReviewScratch({
      collectLiveSessionCwds: async () => new Set(),
      forEachKnownProjectSafely: async (_label, fn) => fn(project),
      cleanup: async ({ paths, projectPath, id }) => {
        cleaned.push(id);
        await fs.rm(paths.assertSafeSessionPath(projectPath, id), { recursive: true, force: true });
      },
    });
    assert.deepEqual(cleaned, [orphanId]);
    assert.deepEqual(await fs.readdir(root), [active.id]);
    await fs.rm(reviewScratchPaths.assertSafeSessionPath(project, active.id), { recursive: true, force: true });
  });
});
