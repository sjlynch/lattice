import {
  buildConflictResolveCommand,
  gitDirExists,
  isMidMerge,
  mainIsAncestorOfWorktree,
  projectGit,
  resyncWithMainAndFinalize,
  writeMergeInstructions,
  type FinalizeOutcome,
  type MergeOutcome,
  type ResyncOutcome,
} from '../worktree.js';
import { listConflictedFiles } from '../worktree/state.js';
import { getTask, type Task } from '../tasks.js';
import { release, tryAcquire } from '../mergeLocks.js';
import { proxyCreateSession } from '../terminalProxy.js';
import {
  notify,
  registerConflictWaiter,
  snapshot,
  type MergeRun,
  type RunState,
} from './state.js';

export type ProcessTargetContext = {
  projectPath: string;
  backendOrigin: string;
  baselineHead: string | null;
  state: RunState;
};

type ProcessTargetResult = 'continue' | 'halt';
type FlaggedConflictResult = ProcessTargetResult | 'fallthrough';

// Run-level "circuit breaker". Between tasks we verify the project repo
// hasn't been damaged: `.git` still exists and HEAD has only moved
// *forward* (a merge run only ever fast-forwards main). If either check
// fails, the run halts immediately — the remaining ready_to_merge tasks
// stay where they are rather than each piling more onto a repo that's
// already in a bad state. Returns `{ ok: false, reason }` on a violation.
async function checkRepoIntegrity(
  repoRoot: string,
  baselineHead: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!(await gitDirExists(repoRoot))) {
    return { ok: false, reason: `${repoRoot}/.git is missing` };
  }
  if (!baselineHead) return { ok: true }; // couldn't read it at the start
  let head: string;
  try {
    const r = await projectGit(repoRoot, ['rev-parse', 'HEAD']);
    if (r.code !== 0) return { ok: false, reason: `cannot read HEAD: ${r.stderr.trim()}` };
    head = r.stdout.trim();
  } catch (err) {
    return { ok: false, reason: `rev-parse HEAD threw: ${(err as Error).message}` };
  }
  if (head === baselineHead) return { ok: true };
  // HEAD moved — it must be a descendant of the baseline (FF), never sideways.
  try {
    const anc = await projectGit(repoRoot, [
      'merge-base',
      '--is-ancestor',
      baselineHead,
      head,
    ]);
    if (anc.code !== 0) {
      return {
        ok: false,
        reason: `HEAD moved non-forward: ${baselineHead.slice(0, 10)} → ${head.slice(0, 10)}`,
      };
    }
  } catch (err) {
    return { ok: false, reason: `merge-base check threw: ${(err as Error).message}` };
  }
  return { ok: true };
}

function formatMergeResult(result: MergeOutcome): string {
  return `${result.status}${result.status === 'conflict' ? ` (${result.conflictedFiles?.join(', ')})` : result.status === 'error' ? `: ${result.message}` : ''}`;
}

function formatFinalizeResult(fin: FinalizeOutcome): string {
  return fin.ok
    ? 'ok'
    : ('stashConflict' in fin
        ? `stash-conflict (${fin.stashConflict.join(', ')})`
        : `error: ${'error' in fin ? fin.error : '?'}`);
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

async function spawnResolverAndNotifyConflict({
  task,
  run,
  runCtx,
  cwd,
  command,
  conflictedFiles,
  recordBeforeSpawn = false,
}: {
  task: Task;
  run: MergeRun;
  runCtx: ProcessTargetContext;
  cwd: string;
  command: string;
  conflictedFiles: string[];
  // Preserve the original failure semantics at each call site: some paths
  // recorded the conflict before spawning the pty, while re-spawn recorded it
  // only after a session was successfully created.
  recordBeforeSpawn?: boolean;
}): Promise<void> {
  if (recordBeforeSpawn) {
    run.conflicted.push(task.id);
  }
  const sess = await proxyCreateSession({
    cwd,
    initialCommand: command,
    projectPath: task.projectPath,
  });
  if (!recordBeforeSpawn) {
    run.conflicted.push(task.id);
  }
  notify(runCtx.state, {
    type: 'conflict',
    runId: run.id,
    projectPath: runCtx.projectPath,
    taskId: task.id,
    command,
    cwd,
    conflictedFiles,
    serverId: 'id' in sess ? sess.id : undefined,
  });
}

async function respawnResolverForFlaggedConflict(
  task: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
): Promise<void> {
  const conflictedFiles = await listConflictedFiles(task.worktreePath!);
  const { relativePath } = await writeMergeInstructions(
    task,
    task.branch!,
    conflictedFiles,
    runCtx.backendOrigin,
    task.worktreePath!,
  );
  const command = buildConflictResolveCommand(relativePath);
  await spawnResolverAndNotifyConflict({
    task,
    run,
    runCtx,
    cwd: task.worktreePath!,
    command,
    conflictedFiles,
  });
}

async function handleResyncOutcome(
  task: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
  outcome: ResyncOutcome,
): Promise<void> {
  if (outcome.kind === 'finalized') {
    run.merged.push(task.id);
    return;
  }

  if (outcome.kind === 'stash-conflict') {
    await spawnResolverAndNotifyConflict({
      task,
      run,
      runCtx,
      cwd: outcome.cwd,
      command: outcome.resolveCommand,
      conflictedFiles: outcome.conflictedFiles,
      recordBeforeSpawn: true,
    });
    // Stop the run — subsequent tasks can't FF until the stash conflict
    // is resolved. /stash-resolved will auto-restart the run.
    run.cancelRequested = true;
    return;
  }

  if (outcome.kind === 'merge-conflict') {
    await spawnResolverAndNotifyConflict({
      task,
      run,
      runCtx,
      cwd: outcome.cwd,
      command: outcome.command,
      conflictedFiles: outcome.conflictedFiles,
      recordBeforeSpawn: true,
    });

    // Fix 2: block the run worker until the resolver's Stop hook fires and
    // /complete signals us. This keeps conflict resolution sequential so each
    // subsequent task's merge sees the latest main HEAD — preventing the
    // "stale resolution" race where resolver B commits against main@v1 and
    // resolver A's finalize has already advanced main to v2 with overlapping
    // changes, forcing a second conflict round.
    //
    // The signal comes from /complete (via signalConflictWaiter) after
    // finalizeMergedTask succeeds, or after a re-sync conflict re-queues the
    // task, or from cancelRunInState on explicit cancellation. In all cases
    // the run simply continues to the next task; run.cancelRequested is the
    // definitive halt signal.
    console.log(`[merge-run] waiting for conflict resolver on task ${task.id}...`);
    await registerConflictWaiter(runCtx.state, run.id, task.id);
    console.log(`[merge-run] conflict resolver done for task ${task.id} — resuming run`);
    return;
  }

  run.errored.push({ taskId: task.id, error: outcome.message });
}

async function finishTaskAndCheckIntegrity(
  run: MergeRun,
  runCtx: ProcessTargetContext,
  taskId: string,
): Promise<ProcessTargetResult> {
  run.processed += 1;
  run.current = undefined;
  notify(runCtx.state, { type: 'progress', run: snapshot(run) });
  console.log(`[merge-run] progress: ${run.processed}/${run.total} (merged=${run.merged.length} conflicts=${run.conflicted.length} errors=${run.errored.length})`);

  // Circuit breaker: bail out of the whole run if the repo looks
  // damaged. Better to leave the remaining tasks at ready_to_merge
  // than to keep processing against a broken `.git`.
  const integrity = await checkRepoIntegrity(runCtx.projectPath, runCtx.baselineHead);
  if (!integrity.ok) {
    console.error(
      `[merge-run] !!! INTEGRITY CHECK FAILED after task ${taskId}: ${integrity.reason}. ` +
        `HALTING RUN — ${run.total - run.processed} task(s) left at ready_to_merge. ` +
        `Inspect the project repo before retrying.`,
    );
    run.errored.push({ taskId: '(run)', error: `halted after ${taskId}: ${integrity.reason}` });
    run.cancelRequested = true;
    return 'halt';
  }

  return run.cancelRequested ? 'halt' : 'continue';
}

async function handleFlaggedConflictTask(
  task: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
): Promise<FlaggedConflictResult> {
  if (!task.conflict) return 'fallthrough';

  if (await isMidMerge(task.worktreePath!)) {
    console.log(`[merge-run] task ${task.id} mid-merge — re-spawning resolver`);
    try {
      await respawnResolverForFlaggedConflict(task, run, runCtx);
    } catch (err) {
      console.error(`[merge-run] re-spawn for ${task.id} failed:`, err);
      run.errored.push({
        taskId: task.id,
        error: `re-spawn resolver failed: ${(err as Error).message}`,
      });
    }
    run.processed += 1;
    return 'continue';
  }

  console.log(
    `[merge-run] task ${task.id} flagged conflict but worktree is clean — re-syncing`,
  );

  // Fix 1: if main is already an ancestor of the worktree branch HEAD,
  // the resolver committed against the current main and nothing else has
  // advanced main since. Skip the re-merge and finalize directly — the
  // re-merge would be a no-op and can spuriously conflict if main moved
  // due to a concurrent backend restart (the Lattice-on-itself scenario).
  let mainAlreadyMerged = false;
  try {
    mainAlreadyMerged = await mainIsAncestorOfWorktree(
      task.projectPath,
      task.worktreePath!,
    );
  } catch (err) {
    console.warn(
      `[merge-run] ancestor check for ${task.id} failed (will re-merge): ${(err as Error).message}`,
    );
  }

  if (!mainAlreadyMerged) {
    // main has advanced since the resolver committed; fall through to the
    // normal merge path to absorb the new commits (may or may not conflict).
    return 'fallthrough';
  }

  console.log(
    `[merge-run] task ${task.id}: main already incorporated in branch — finalizing directly`,
  );
  if (!tryAcquire(task.id)) {
    console.warn(`[merge-run] task ${task.id} lock held — skipping`);
    run.errored.push({
      taskId: task.id,
      error: 'merge lock held by another caller; skipped',
    });
  } else {
    try {
      const outcome = await resyncWithMainAndFinalize(
        task,
        runCtx.backendOrigin,
        mergeRunResyncOptions(task, { assumeMainAlreadyIncorporated: true }),
      );
      await handleResyncOutcome(task, run, runCtx, outcome);
    } catch (err) {
      console.error(`[merge-run] uncaught error finalizing ${task.id}:`, err);
      run.errored.push({
        taskId: task.id,
        error: (err as Error).message ?? 'unknown error',
      });
    } finally {
      release(task.id);
    }
  }

  return finishTaskAndCheckIntegrity(run, runCtx, task.id);
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
  const flaggedConflictResult = await handleFlaggedConflictTask(task, run, runCtx);
  if (flaggedConflictResult !== 'fallthrough') {
    return flaggedConflictResult;
  }

  if (!tryAcquire(task.id)) {
    console.warn(`[merge-run] task ${task.id} lock held — skipping`);
    run.errored.push({
      taskId: task.id,
      error: 'merge lock held by another caller; skipped',
    });
    run.processed += 1;
    return 'continue';
  }

  try {
    const outcome = await resyncWithMainAndFinalize(
      task,
      runCtx.backendOrigin,
      mergeRunResyncOptions(task),
    );
    await handleResyncOutcome(task, run, runCtx, outcome);
  } catch (err) {
    console.error(`[merge-run] uncaught error for task ${task.id}:`, err);
    run.errored.push({
      taskId: task.id,
      error: (err as Error).message ?? 'unknown error',
    });
  } finally {
    release(task.id);
  }

  return finishTaskAndCheckIntegrity(run, runCtx, task.id);
}
