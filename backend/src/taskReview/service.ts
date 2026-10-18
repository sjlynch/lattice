import {
  getTask, updateTaskCrashSafe, updateTaskWith, appendSummaryText,
  type Task, type TaskUpdates,
} from '../tasks.js';
import { getUserSettings, taskReviewIn, taskReviewerIn, type UserSettings } from '../userSettings.js';
import { normalizeAgentModel, normalizeAgentEffort, isAgentHarness } from '../harnesses.js';
import { normalizePiModel } from '../agentCommandBuilder.js';
import { cleanupWorktreeForTask } from '../worktree.js';
import { acquireBriefly, release } from '../mergeLocks.js';
import { registerMemGauge } from '../memDiag/gauges.js';
import { keepReviewAttempt, reviewHead } from './git.js';
import { runTaskReview, type ReviewResult } from './runner.js';
import { createReviewQueue } from './queue.js';

const queue = createReviewQueue();
registerMemGauge('taskReview.jobs', () => queue.size);
registerMemGauge('taskReview.active', () => queue.active);

export type ReviewDeps = {
  head: typeof reviewHead;
  run: typeof runTaskReview;
  keep: typeof keepReviewAttempt;
  cleanup: (task: Task) => Promise<boolean>;
  enqueue: (task: Task, backendOrigin: string) => Promise<void>;
};
const defaultDeps: ReviewDeps = {
  head: reviewHead, run: runTaskReview, keep: keepReviewAttempt,
  cleanup: (task) => cleanupWorktreeForTask(task.projectPath, task.worktreePath!, task.branch!, undefined, { keepBranchIfUnmerged: true }),
  // Dynamic import keeps the completion -> queue -> start -> worktree graph
  // acyclic; this is the exact persisted queue path used by explicit Run.
  enqueue: async (task, origin) => {
    const { enqueueTaskRun } = await import('../routes/tasks/queuedSpawn.js');
    await enqueueTaskRun(task.id, origin, task.runQueuedHarness, task.runQueuedPiModel, {
      model: task.runQueuedModel, effort: task.runQueuedEffort,
    }, { requireQueued: true });
  },
};

function matches(current: Task, expected: Task): boolean {
  return current.status === 'in_progress' && current.branch === expected.branch &&
    current.worktreePath === expected.worktreePath && current.review?.head === expected.review?.head &&
    current.review?.startedAt === expected.review?.startedAt && current.review?.status === expected.review?.status;
}

async function stillCurrent(task: Task, deps: ReviewDeps): Promise<boolean> {
  const current = await getTask(task.id);
  if (!current || !matches(current, task)) return false;
  try { return await deps.head(current) === task.review?.head; }
  catch { return false; } // Unknown head cannot authorize teardown or merging.
}

// Check duplicates before recounting commits: main may have caught up since
// admission, but the same completed head must still acknowledge as a no-op.
export async function isReviewedTaskHead(task: Task, deps: Pick<ReviewDeps, 'head'> = defaultDeps): Promise<boolean> {
  if (!task.review || taskReviewIn(await getUserSettings(task.projectPath)) === 'off') return false;
  try { return await deps.head(task) === task.review.head; }
  catch { return false; }
}

// Called only after /complete's commit-count decision. An absent/off setting
// returns before probing HEAD or mutating anything in the existing flip path.
export async function beginTaskReview(
  task: Task, backendOrigin: string, deps: ReviewDeps = defaultDeps,
): Promise<'off' | 'reviewing' | 'noop'> {
  const settings = await getUserSettings(task.projectPath);
  if (taskReviewIn(settings) === 'off') return 'off';
  let head: string;
  try { head = await deps.head(task); }
  catch (error) {
    // A broken git probe is a review error and fails open, just as a missing
    // CLI does. Do not strand an already-finished agent at In Progress.
    const { harness, model } = taskReviewerIn(settings);
    await updateTaskCrashSafe(task.id, {
      status: 'ready_to_merge', completedAt: Date.now(),
      review: { status: 'error', head: '', startedAt: Date.now(), finishedAt: Date.now(),
        attempt: task.review?.attempt ?? 1, reviewer: `${harness}/${model}`, reason: String(error).slice(0, 300) },
    }, (current) => current.status === 'in_progress' && current.branch === task.branch && current.review === task.review);
    return 'noop';
  }
  const review = { status: 'reviewing' as const, head, startedAt: Date.now(), attempt: task.review?.attempt ?? 1 };
  let admitted = false;
  const updated = await updateTaskCrashSafe(task.id, { review }, async (current) => {
    admitted = current.status === 'in_progress' && current.branch === task.branch && current.worktreePath === task.worktreePath &&
      current.review?.head !== head && await deps.head(current) === head;
    if (admitted) review.attempt = current.review?.attempt ?? 1;
    return admitted;
  });
  if (!updated && admitted) throw new Error('Task review could not be persisted');
  if (!updated) return 'noop';
  resumeTaskReview(updated, backendOrigin, deps);
  return 'reviewing';
}

// Recovery and completion share single flight. A newer head arriving while an
// older CLI runs is picked up serially, so their scratch/output never overlap.
export function resumeTaskReview(task: Task, backendOrigin: string, deps: ReviewDeps = defaultDeps): void {
  queue.enqueue(task.id, async () => {
    let current = await getTask(task.id);
    while (current?.status === 'in_progress' &&
        (current.review?.status === 'reviewing' || current.review?.status === 'rerun')) {
      const snapshot = current;
      let reviewer = snapshot.review!.reviewer;
      try {
        if (snapshot.review!.status === 'rerun') {
          if (!snapshot.review!.rerunPending) return;
          const lock = await acquireBriefly(snapshot.id, 5_000);
          if (!lock) return;
          try { await finishReviewRerun(snapshot, backendOrigin, deps); }
          finally { release(lock); }
        } else {
          const settings = await getUserSettings(snapshot.projectPath);
          const result = await deps.run(snapshot, settings);
          reviewer = result.reviewer;
          await applyReviewResult(snapshot, result, settings, backendOrigin, deps);
        }
      } catch (error) {
        // Setup/teardown failures are also fail-open, but may only flip the
        // still-current review. Never turn a stale job's exception into a flip.
        const failed = await getTask(task.id);
        if (failed?.review && failed.status === 'in_progress' &&
            failed.review.head === snapshot.review!.head && failed.review.startedAt === snapshot.review!.startedAt) {
          const config = taskReviewerIn(await getUserSettings(failed.projectPath));
          await applyReviewResult(failed, { verdict: 'error', reviewer: reviewer ?? `${config.harness}/${config.model}`,
            reason: String(error instanceof Error ? error.message : error).slice(0, 300) }, {}, backendOrigin, deps);
        }
      }
      current = await getTask(task.id);
      // Unchanged review means a stale head or failed write. Leave it alone;
      // a fresh completion/boot may retry it, never spin on the same verdict.
      if (current?.review?.head === snapshot.review?.head &&
          current?.review?.startedAt === snapshot.review?.startedAt) break;
    }
  }, { reschedule: true });
}

export async function applyReviewResult(
  task: Task, result: ReviewResult, settings: UserSettings, backendOrigin: string,
  deps: ReviewDeps = defaultDeps,
): Promise<void> {
  if (!task.review || !await stillCurrent(task, deps)) return;
  const review = {
    ...task.review, status: result.verdict === 'accept' ? 'accepted' as const : result.verdict === 'reject' ? 'rejected' as const : 'error' as const,
    p: result.p, reason: result.reason.slice(0, 300), reviewer: result.reviewer, finishedAt: Date.now(),
  };
  const doubtful = `Second opinion (${review.reviewer}): doubtful — ${review.reason}`;
  const rerun = result.verdict === 'reject' && taskReviewIn(settings) === 'rerun' &&
    task.review.attempt === 1 && isAgentHarness(settings.taskReviewRerunHarness);
  if (rerun) {
    // Serialize teardown against task delete/manual merge. Never hold this
    // across the reviewer CLI (up to ten minutes).
    const lock = await acquireBriefly(task.id, 5_000);
    if (!lock) return;
    try {
      if (!await stillCurrent(task, deps)) return;
      const keptBranch = await deps.keep(task, task.review.head);
      const outcome = await updateTaskWith(task.id, async (current) => {
        if (!matches(current, task) || await deps.head(current) !== task.review!.head) return { result: false };
        return { result: true, updates: {
          review: { ...review, status: 'rerun', attempt: 2, keptBranch, rerunPending: true },
          runQueuedHarness: settings.taskReviewRerunHarness,
          runQueuedPiModel: normalizePiModel(settings.taskReviewRerunPiModel),
          runQueuedModel: normalizeAgentModel(settings.taskReviewRerunModel),
          runQueuedEffort: normalizeAgentEffort(settings.taskReviewRerunEffort),
          summary: appendSummaryText(current.summary, `${doubtful}. Re-running with ${settings.taskReviewRerunHarness}/${
            settings.taskReviewRerunHarness === 'pi' ? settings.taskReviewRerunPiModel || 'default' : settings.taskReviewRerunModel || 'default'
          }; the first attempt is on branch ${keptBranch}.`),
        } satisfies TaskUpdates };
      }, { crashSafe: true });
      if (outcome?.result) await finishReviewRerun(outcome.task, backendOrigin, deps);
    } finally { release(lock); }
    return;
  }
  await updateTaskWith(task.id, async (current) => !matches(current, task) || await deps.head(current) !== task.review!.head ? { result: false } : {
    result: true, updates: {
      status: 'ready_to_merge', completedAt: Date.now(), review,
      ...(result.verdict === 'reject' ? { summary: appendSummaryText(current.summary, doubtful) } : {}),
    },
  }, { crashSafe: true });
}

async function finishReviewRerun(task: Task, backendOrigin: string, deps: ReviewDeps): Promise<void> {
  if (!task.review?.keptBranch || !task.review.rerunPending || !await stillCurrent(task, deps)) return;
  const cleaned = await deps.cleanup(task);
  if (!cleaned) {
    await updateTaskWith(task.id, async (current) => !matches(current, task) || await deps.head(current) !== task.review!.head ? { result: false } : {
      result: true, updates: { status: 'ready_to_merge', completedAt: Date.now(),
        review: { ...task.review!, status: 'error', finishedAt: Date.now(), reason: 'Fresh rerun could not safely remove the first checkout' } },
    }, { crashSafe: true });
    return;
  }
  // The original branch is kept by teardown. Verify it again before exposing
  // Open; a user lane move/delete or a newly committed head withdraws rerun.
  if (!await stillCurrent(task, deps)) return;
  const outcome = await updateTaskWith(task.id, async (current) => !matches(current, task) || await deps.head(current) !== task.review!.head ? { result: false } : {
    result: true, updates: {
      status: 'open', review: { ...task.review!, rerunPending: false }, worktreePath: undefined, branch: undefined,
      agentSession: undefined, startedAt: undefined, completedAt: undefined,
      runQueued: true, runQueuedAt: Date.now(), runFailureCount: undefined, runWaitingForDisk: undefined,
    },
  }, { crashSafe: true });
  if (outcome?.result) await deps.enqueue(outcome.task, backendOrigin);
}
