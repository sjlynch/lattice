import type { WorkflowRun, WorkflowRunStatus } from '../../../api';
import type { QueueAction, StartedEntry } from '../queueScheduler';
import { sameProjectPath } from '../../../terminal/terminalScope';
import type { StartOutcome } from './useWorkflowRunActions';

// Pure halves of `useWorkflowQueue`: which queue actions a /run outcome maps
// to, and which runs that left `activeRuns` to report vs. resolve. The hook
// keeps every ref, cancellation check and side effect.

// The queue actions to dispatch, in order, for one entry's /run outcome.
// A started/finished run for a project other than `startProject` is treated
// as a failed start.
export function queueActionsForStartOutcome(
  outcome: StartOutcome,
  entryId: string,
  startProject: string,
): QueueAction[] {
  if (outcome.status === 'started' && sameProjectPath(outcome.run.projectPath, startProject)) {
    return [{ type: 'workflowStarted', entryId, runId: outcome.run.id }];
  }
  if (outcome.status === 'finished' && sameProjectPath(outcome.run.projectPath, startProject)) {
    // The completion WS event arrived before /run returned, so this run
    // never appeared in activeRuns and the diff effect cannot emit
    // runFinished for it. Feed the scheduler both halves in order: buffer
    // the finish, then attach/consume the matching run id. This retires
    // the entry, advancing only on success and stopping on failure/cancellation.
    return [
      { type: 'runFinished', runId: outcome.run.id, status: outcome.run.status },
      { type: 'workflowStarted', entryId, runId: outcome.run.id },
    ];
  }
  if (outcome.status === 'busy') {
    // Backend rejected the start (409): a run is already active. Requeue
    // with a retry delay so a stale active-run snapshot cannot cause a loop.
    return [{ type: 'dispatchRejected', entryId }];
  }
  if (outcome.status === 'uncertain') {
    // Stop before retiring the entry so the next workflow cannot start while
    // this one's outcome (including failure/cancellation) is still unknown.
    return [{ type: 'stopQueue' }, { type: 'dispatchFailed', entryId }];
  }
  return [{ type: 'dispatchFailed', entryId }];
}

export type VanishedRunClassification = {
  // Report now via runFinished: the run has a recorded final status, or the
  // queue doesn't own it ('errored' then — a no-op for an untracked id).
  report: { runId: string; status: WorkflowRunStatus }[];
  // Queue-owned runs that vanished without a terminal event; resolve them
  // through `resolveVanishedRun` (see the hook's diff effect).
  resolve: string[];
};

// Runs present in `prev` but gone from `next`, split by how to report them.
export function classifyVanishedRuns(
  prev: Record<string, WorkflowRun>,
  next: Record<string, WorkflowRun>,
  recentRuns: Record<string, WorkflowRun>,
  startedEntries: readonly StartedEntry[],
): VanishedRunClassification {
  const report: VanishedRunClassification['report'] = [];
  const resolve: string[] = [];
  for (const id of Object.keys(prev)) {
    if (next[id]) continue;
    const recentStatus = recentRuns[id]?.status;
    const owned = startedEntries.some((entry) => entry.runId === id);
    if (recentStatus || !owned) {
      report.push({ runId: id, status: recentStatus ?? 'errored' });
    } else {
      resolve.push(id);
    }
  }
  return { report, resolve };
}
