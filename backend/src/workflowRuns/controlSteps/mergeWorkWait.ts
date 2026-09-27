// `waitForMergeWork` — the merge step's combined queued / In Progress /
// Ready-to-Merge wait (re-exported from shared.ts).

import type { Task } from '../../tasks.js';
import { hasSpawnRequest } from '../../spawnQueue.js';
import { taskRunDedupeKey } from '../../routes/tasks/queuedSpawnAdmission.js';
import type { WorkflowRun } from '../state.js';
import { productionLaneWaitDeps, type LaneWaitDeps } from './laneWait.js';
import { createUnrefTimer, createWaitSettler, isRunEndedEvent } from './waitPrimitives.js';

// Fallback poll for live-request changes, which have no task-store event.
const MERGE_WORK_POLL_MS = 1000;

// Per-task lifecycle phases, ordered so a higher number is forward progress.
const PHASE_QUEUED = 1;
const PHASE_RUNNING = 2;
const PHASE_GONE = 3;

export type MergeWorkWaitDeps = LaneWaitDeps & {
  hasQueuedRun: (taskId: string) => boolean;
};

const productionMergeWorkWaitDeps: MergeWorkWaitDeps = {
  ...productionLaneWaitDeps,
  hasQueuedRun: (id) => hasSpawnRequest(taskRunDedupeKey(id)),
};

// Wake when there is work to merge OR no admitted task runs remain. Waiting
// for every queued start before merging would deadlock disk-held starts:
// diskPressureMerge leaves active workflows to free their own worktrees.
// Ordinary Open/Backlog tasks have neither admission marker and do not block.
export function waitForMergeWork(
  projectPath: string,
  run: WorkflowRun,
  onProgress: (count: number, total: number) => void,
  maxWaitMs: number,
  deps: MergeWorkWaitDeps = productionMergeWorkWaitDeps,
): Promise<Task[]> {
  return new Promise((resolve, reject) => {
    let lastCount = 0;
    let total = 0;
    let revision = 0;
    let reading = false;
    // Track forward transitions by task, not just a count: queued -> running
    // is progress even when the combined count stays the same. Keep the highest
    // phase seen so repeated metadata updates / backwards flips cannot extend
    // a stalled wait indefinitely.
    const phases = new Map<string, number>();
    let unsubTasks: (() => void) | undefined;
    let unsubRun: (() => void) | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const timer = createUnrefTimer(maxWaitMs, () => fail(new Error(
      `waitForMergeWork: queued/In Progress tasks made no progress for ${maxWaitMs}ms ` +
      `(${lastCount} task(s) still pending) — aborting so the project run-lock is released`,
    )));

    const cleanup = () => {
      unsubTasks?.();
      unsubTasks = undefined;
      unsubRun?.();
      unsubRun = undefined;
      timer.clear();
      if (poll) clearInterval(poll);
    };
    const { finish, fail, settled } = createWaitSettler<Task[]>({ resolve, reject, cleanup });

    const evaluate = (tasks: Task[]) => {
      if (settled()) return;
      if (run.status !== 'running') { finish([]); return; }
      const pending = new Map<string, number>();
      for (const task of tasks) {
        if (task.status === 'in_progress') pending.set(task.id, PHASE_RUNNING);
        else if (task.runQueued === true || deps.hasQueuedRun(task.id)) pending.set(task.id, PHASE_QUEUED);
      }
      let progressed = false;
      for (const [id, phase] of pending) {
        const previous = phases.get(id);
        if (previous !== undefined && phase > previous) progressed = true;
        phases.set(id, Math.max(previous ?? 0, phase));
      }
      for (const [id, phase] of phases) {
        if (!pending.has(id) && phase < PHASE_GONE) {
          phases.set(id, PHASE_GONE);
          progressed = true;
        }
      }
      lastCount = pending.size;
      total = Math.max(total, phases.size, 1);
      if (progressed) timer.arm();
      onProgress(lastCount, total);
      if (tasks.some((t) => t.status === 'ready_to_merge') || lastCount === 0) finish(tasks);
    };
    const read = () => {
      if (settled() || reading) return;
      reading = true;
      const readRevision = revision;
      try {
        void deps.listTasks(projectPath).then((tasks) => {
          // A store notification received during this read is more recent.
          if (readRevision === revision) evaluate(tasks);
        }).catch(fail).finally(() => { reading = false; });
      } catch (err) {
        reading = false;
        fail(err);
      }
    };

    // Bound the initial read too, and subscribe before reading. Queue settlement
    // has no task-store event of its own (the failure flag may clear BEFORE the
    // live request disappears), so poll as a fallback for live-request changes.
    timer.arm();
    try {
      unsubTasks = deps.subscribeTasks((project, tasks) => {
        if (settled() || project !== projectPath) return;
        revision += 1;
        try { evaluate(tasks); } catch (err) { fail(err); }
      });
      if (settled()) { cleanup(); return; }
      unsubRun = deps.subscribeRun((ev) => {
        if (isRunEndedEvent(ev, run.id)) finish([]);
      });
      if (settled()) { cleanup(); return; }
      if (run.status !== 'running') { finish([]); return; }
      poll = setInterval(read, MERGE_WORK_POLL_MS);
      poll.unref?.();
      read();
    } catch (err) {
      fail(err);
    }
  });
}
