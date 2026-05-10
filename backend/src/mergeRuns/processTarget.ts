import {
  buildConflictResolveCommand,
  finalizeMergedTask,
  gitDirExists,
  isMidMerge,
  mergeWorktreeInRepo,
  projectGit,
  writeMergeInstructions,
  type MergeOutcome,
} from '../worktree.js';
import { listConflictedFiles } from '../worktree/state.js';
import { getTask, updateTask, type Task } from '../tasks.js';
import { release, tryAcquire } from '../mergeLocks.js';
import { proxyCreateSession } from '../terminalProxy.js';
import { notify, snapshot, type MergeRun, type RunState } from './state.js';

export type ProcessTargetContext = {
  projectPath: string;
  backendOrigin: string;
  baselineHead: string | null;
  state: RunState;
};

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
  const sess = await proxyCreateSession({
    cwd: task.worktreePath!,
    initialCommand: command,
    projectPath: task.projectPath,
  });
  run.conflicted.push(task.id);
  notify(runCtx.state, {
    type: 'conflict',
    runId: run.id,
    projectPath: runCtx.projectPath,
    taskId: task.id,
    command,
    cwd: task.worktreePath!,
    conflictedFiles,
    serverId: 'id' in sess ? sess.id : undefined,
  });
}

async function handleCleanMerge(
  task: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
): Promise<void> {
  console.log(`[merge-run] finalizing task ${task.id}...`);
  const fin = await finalizeMergedTask(task, runCtx.backendOrigin);
  console.log(`[merge-run] finalize → ${fin.ok ? 'ok' : ('stashConflict' in fin ? `stash-conflict (${fin.stashConflict.join(', ')})` : `error: ${'error' in fin ? fin.error : '?'}`)}`);
  if (fin.ok) {
    run.merged.push(task.id);
  } else if ('stashConflict' in fin) {
    run.conflicted.push(task.id);
    const sess = await proxyCreateSession({
      cwd: fin.cwd,
      initialCommand: fin.resolveCommand,
      projectPath: task.projectPath,
    });
    notify(runCtx.state, {
      type: 'conflict',
      runId: run.id,
      projectPath: runCtx.projectPath,
      taskId: task.id,
      command: fin.resolveCommand,
      cwd: fin.cwd,
      conflictedFiles: fin.stashConflict,
      serverId: 'id' in sess ? sess.id : undefined,
    });
    // Stop the run — subsequent tasks can't FF until the stash conflict
    // is resolved. /stash-resolved will auto-restart the run.
    run.cancelRequested = true;
  } else {
    run.errored.push({
      taskId: task.id,
      error: 'error' in fin ? fin.error : 'finalize failed',
    });
  }
}

async function handleMergeConflict(
  task: Task,
  run: MergeRun,
  result: Extract<MergeOutcome, { status: 'conflict' }>,
  runCtx: ProcessTargetContext,
): Promise<void> {
  console.log(`[merge-run] writing merge instructions for ${task.id}`);
  const { relativePath } = await writeMergeInstructions(
    task,
    task.branch!,
    result.conflictedFiles,
    runCtx.backendOrigin,
    task.worktreePath!,
  );
  await updateTask(task.id, {
    conflict: true,
    conflictStartedAt: Date.now(),
  });
  run.conflicted.push(task.id);
  const command = buildConflictResolveCommand(relativePath);
  const sess = await proxyCreateSession({
    cwd: task.worktreePath!,
    initialCommand: command,
    projectPath: task.projectPath,
  });
  notify(runCtx.state, {
    type: 'conflict',
    runId: run.id,
    projectPath: runCtx.projectPath,
    taskId: task.id,
    command,
    cwd: task.worktreePath!,
    conflictedFiles: result.conflictedFiles,
    serverId: 'id' in sess ? sess.id : undefined,
  });
}

export async function processTarget(
  seed: Task,
  run: MergeRun,
  runCtx: ProcessTargetContext,
): Promise<'continue' | 'halt'> {
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
  //     Fall through and let mergeWorktreeInRepo detect the merge is
  //     already done; the path returns `clean` and we finalize.
  // Old behavior was a flat skip, which left conflict tasks stranded
  // forever once the run loop exited.
  if (task.conflict) {
    if (await isMidMerge(task.worktreePath)) {
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
    console.log(`[merge-run] merging worktree for ${task.id} (branch=${task.branch})`);
    const result = await mergeWorktreeInRepo(
      task.projectPath,
      task.branch,
      task.worktreePath,
      task.id,
      runCtx.backendOrigin,
      task.title,
    );
    console.log(`[merge-run] mergeWorktreeInRepo → ${result.status}${result.status === 'conflict' ? ` (${result.conflictedFiles?.join(', ')})` : result.status === 'error' ? `: ${result.message}` : ''}`);
    if (result.status === 'clean') {
      await handleCleanMerge(task, run, runCtx);
    } else if (result.status === 'conflict') {
      await handleMergeConflict(task, run, result, runCtx);
    } else {
      run.errored.push({ taskId: task.id, error: result.message });
    }
  } catch (err) {
    console.error(`[merge-run] uncaught error for task ${task.id}:`, err);
    run.errored.push({
      taskId: task.id,
      error: (err as Error).message ?? 'unknown error',
    });
  } finally {
    release(task.id);
  }

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
      `[merge-run] !!! INTEGRITY CHECK FAILED after task ${task.id}: ${integrity.reason}. ` +
        `HALTING RUN — ${run.total - run.processed} task(s) left at ready_to_merge. ` +
        `Inspect the project repo before retrying.`,
    );
    run.errored.push({ taskId: '(run)', error: `halted after ${task.id}: ${integrity.reason}` });
    run.cancelRequested = true;
    return 'halt';
  }

  return run.cancelRequested ? 'halt' : 'continue';
}
