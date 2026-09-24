import {
  resyncWithMainAndFinalize,
  type FinalizeOutcome,
  type MergeOutcome,
} from '../worktree.js';
import { getTask, type Task } from '../tasks.js';
import {
  notify,
  snapshot,
  type MergeRun,
  type RunState,
} from './state.js';
import { handleFlaggedConflictTask } from './flaggedConflict.js';
import { finishTaskAndCheckIntegrity } from './repoIntegrity.js';
import { handleResyncOutcome } from './resolverSpawn.js';
import { withMergeLock } from './withMergeLock.js';

export type ProcessTargetContext = {
  projectPath: string;
  backendOrigin: string;
  baselineHead: string | null;
  state: RunState;
};

export type ProcessTargetResult = 'continue' | 'halt';

export type ProcessOutcome =
  | { kind: 'finalized' }
  | { kind: 'spawned-resolver' }
  | { kind: 'awaiting-resolver' }
  | { kind: 'errored' }
  | { kind: 'integrity-halt' }
  | { kind: 'lock-halt' }
  | { kind: 'disk-halt' };

function formatMergeResult(result: MergeOutcome): string {
  return `${result.status}${result.status === 'conflict' ? ` (${result.conflictedFiles?.join(', ')})` : result.status === 'error' ? `: ${result.message}` : ''}`;
}

function formatFinalizeResult(fin: FinalizeOutcome): string {
  if (fin.ok) return 'ok';
  if ('stashConflict' in fin) return `stash-conflict (${fin.stashConflict.join(', ')})`;
  if ('mergeConflict' in fin) return `merge-conflict (${fin.mergeConflict.join(', ')})`;
  return `error: ${'error' in fin ? fin.error : '?'}`;
}

function mergeRunResyncOptions(
  task: Task,
  opts: { assumeMainAlreadyIncorporated?: boolean } = {},
) {
  return {
    assumeMainAlreadyIncorporated: opts.assumeMainAlreadyIncorporated,
    onBeforeMerge: () => {
      console.log(`[merge-run] merging worktree for ${task.id} (branch=${task.branch})`);
    },
    onMergeResult: (result: MergeOutcome) => {
      console.log(`[merge-run] mergeWorktreeInRepo → ${formatMergeResult(result)}`);
    },
    onBeforeWriteMergeInstructions: () => {
      console.log(`[merge-run] writing merge instructions for ${task.id}`);
    },
    onBeforeFinalize: () => {
      console.log(`[merge-run] finalizing task ${task.id}...`);
    },
    onFinalizeResult: (fin: FinalizeOutcome) => {
      console.log(`[merge-run] finalize → ${formatFinalizeResult(fin)}`);
    },
  };
}

function processTargetResultForOutcome(
  run: MergeRun,
  outcome: ProcessOutcome,
): ProcessTargetResult {
  switch (outcome.kind) {
    case 'integrity-halt':
    case 'lock-halt':
    case 'disk-halt':
      return 'halt';
    case 'finalized':
    case 'spawned-resolver':
    case 'awaiting-resolver':
    case 'errored':
      return run.cancelRequested ? 'halt' : 'continue';
  }
}

async function finishWithIntegrity(
  run: MergeRun,
  runCtx: ProcessTargetContext,
  taskId: string,
  outcome: ProcessOutcome,
): Promise<ProcessTargetResult> {
  const checkedOutcome = await finishTaskAndCheckIntegrity(run, runCtx, taskId, outcome);
  return processTargetResultForOutcome(run, checkedOutcome);
}

export async function processTarget(
  seed: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
): Promise<ProcessTargetResult> {
  if (run.cancelRequested) return 'halt';

  run.current = seed.id;
  notify(runCtx.state, { type: 'progress', run: snapshot(run) });

  // Re-read the task so we see any state changes since the run started
  // (manual /merge, user dragging the card to a different lane, etc.).
  const task = await getTask(seed.id);
  if (!task) {
    console.warn(`[merge-run] task ${seed.id} disappeared — skipping`);
    run.errored.push({ taskId: seed.id, error: 'task disappeared' });
    run.processed += 1;
    return 'continue';
  }
  console.log(`[merge-run] processing "${task.title.slice(0, 50)}" (${task.id})`);
  if (task.status !== 'ready_to_merge') {
    console.log(`[merge-run] task ${task.id} is ${task.status} — skipping`);
    run.processed += 1;
    return 'continue';
  }
  if (!task.branch || !task.worktreePath) {
    console.warn(`[merge-run] task ${task.id} has no branch/worktree — skipping`);
    run.errored.push({
      taskId: task.id,
      error: 'task has no worktree branch on record',
    });
    run.processed += 1;
    return 'continue';
  }

  // Already-flagged conflict: two cases.
  //   - Worktree is mid-merge (resolver Claude died, server restarted,
  //     or user closed the tab before resolution). Re-spawn the
  //     resolver session and re-emit the conflict event.
  //   - Worktree is NOT mid-merge (resolver finished and committed,
  //     but finalize was interrupted — e.g. server restart, FF race).
  //     Fix 1: check whether main is already incorporated into the branch.
  //     If so, finalize directly (no re-merge needed). If not (main
  //     advanced since the resolver committed), fall through to the
  //     normal merge path which will re-merge main into the branch.
  // Old behavior was a flat skip, which left conflict tasks stranded
  // forever once the run loop exited.
  const flaggedConflictResult = await handleFlaggedConflictTask(
    task,
    run,
    runCtx,
    mergeRunResyncOptions,
  );
  if (flaggedConflictResult.action === 'handled') {
    return processTargetResultForOutcome(run, flaggedConflictResult.outcome);
  }

  const locked = await withMergeLock(task, run, 'for task', async (lock) => {
    const resyncOutcome = await resyncWithMainAndFinalize(
      task,
      runCtx.backendOrigin,
      mergeRunResyncOptions(task),
    );
    return handleResyncOutcome(task, run, runCtx, resyncOutcome, lock);
  });
  if (locked.kind === 'lock-unavailable') {
    run.processed += 1;
    return 'continue';
  }

  return finishWithIntegrity(run, runCtx, task.id, locked.outcome);
}
