import {
  gitDirExists,
  projectGit,
} from '../worktree.js';
import {
  clearStaleGitLocks,
  describeBlockingLocks,
  gitLockPathFromError,
} from '../worktree/staleGitLocks.js';
import { isDiskFullMessage } from '../worktree/diskFull.js';
import {
  notify,
  snapshot,
  type MergeRun,
} from './state.js';
import type {
  ProcessOutcome,
  ProcessTargetContext,
} from './processTarget.js';

// Run-level "circuit breaker". Between tasks we verify the project repo
// hasn't been damaged: `.git` still exists and HEAD has only moved
// *forward* (a merge run only ever fast-forwards main). If either check
// fails, the run halts immediately — the remaining ready_to_merge tasks
// stay where they are rather than each piling more onto a repo that's
// already in a bad state. Returns `{ ok: false, reason }` on a violation.
export async function checkRepoIntegrity(
  repoRoot: string,
  baselineHead: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await inspectRepoIntegrity(repoRoot, baselineHead);
  return r.ok ? { ok: true } : r;
}

// checkRepoIntegrity plus the HEAD it verified (null when there was no
// baseline to compare against), so the caller can advance its baseline.
async function inspectRepoIntegrity(
  repoRoot: string,
  baselineHead: string | null,
): Promise<{ ok: true; head: string | null } | { ok: false; reason: string }> {
  if (!(await gitDirExists(repoRoot))) {
    return { ok: false, reason: `${repoRoot}/.git is missing` };
  }
  if (!baselineHead) return { ok: true, head: null }; // couldn't read it at the start
  let head: string;
  try {
    const r = await projectGit(repoRoot, ['rev-parse', 'HEAD']);
    if (r.code !== 0) return { ok: false, reason: `cannot read HEAD: ${r.stderr.trim()}` };
    head = r.stdout.trim();
  } catch (err) {
    return { ok: false, reason: `rev-parse HEAD threw: ${(err as Error).message}` };
  }
  if (head === baselineHead) return { ok: true, head };
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
  return { ok: true, head };
}

export async function finishTaskAndCheckIntegrity(
  run: MergeRun,
  runCtx: ProcessTargetContext,
  taskId: string,
  outcome: ProcessOutcome,
): Promise<ProcessOutcome> {
  run.processed += 1;
  run.current = undefined;
  notify(runCtx.state, { type: 'progress', run: snapshot(run) });
  console.log(`[merge-run] progress: ${run.processed}/${run.total} (merged=${run.merged.length} conflicts=${run.conflicted.length} errors=${run.errored.length})`);

  // Circuit breaker: bail out of the whole run if the repo looks
  // damaged. Better to leave the remaining tasks at ready_to_merge
  // than to keep processing against a broken `.git`.
  const integrity = await inspectRepoIntegrity(runCtx.projectPath, runCtx.baselineHead);
  if (!integrity.ok) {
    console.error(
      `[merge-run] !!! INTEGRITY CHECK FAILED after task ${taskId}: ${integrity.reason}. ` +
        `HALTING RUN — ${run.total - run.processed} task(s) left at ready_to_merge. ` +
        `Inspect the project repo before retrying.`,
    );
    run.errored.push({ taskId: '(run)', error: `halted after ${taskId}: ${integrity.reason}` });
    run.cancelRequested = true;
    return { kind: 'integrity-halt' };
  }
  // Advance the baseline to the HEAD just verified. Comparing only against the
  // run-START head let a rewind back to it (task 1 FF'd A→B, something reset
  // main to A) pass as "unchanged" while task 1 — already qa, branch deleted —
  // had silently lost its commits from main.
  if (integrity.head) runCtx.baselineHead = integrity.head;

  if (outcome.kind === 'errored' && lastErrorFor(run, taskId, isDiskFullMessage)) {
    // Every remaining task would fail the same way — and a merge that runs out
    // of disk part-way leaves its worktree half-merged, or main fast-forwarded
    // with the task's state unsaved (2026-09-24: 22 of 22 tasks). Stop once.
    const left = run.total - run.processed;
    console.error(`[merge-run] !!! the disk is (nearly) full. HALTING RUN — ${left} task(s) left at ready_to_merge.`);
    run.errored.push({
      taskId: '(run)',
      error:
        `halted after ${taskId}: the disk is (nearly) full. The remaining ${left} task(s) stay Ready to Merge — ` +
        'free disk space, then start Merge All again (each merged task frees its worktree).',
    });
    run.cancelRequested = true;
    return { kind: 'disk-halt' };
  }
  if (outcome.kind === 'errored') {
    const reason = await persistentLockReason(run, runCtx.projectPath, taskId);
    if (reason) {
      const left = run.total - run.processed;
      console.error(`[merge-run] !!! ${reason}. HALTING RUN — ${left} task(s) left at ready_to_merge.`);
      run.errored.push({
        taskId: '(run)',
        error:
          `halted after ${taskId}: ${reason}. The remaining ${left} task(s) stay Ready to Merge — ` +
          'start Merge All again once no git command is running in the project (delete the lock file if none is).',
      });
      run.cancelRequested = true;
      return { kind: 'lock-halt' };
    }
  }

  return outcome;
}

// The newest error recorded for `taskId`, when it matches `test`.
function lastErrorFor(run: MergeRun, taskId: string, test: (message: string) => boolean): boolean {
  const last = [...run.errored].reverse().find((e) => e.taskId === taskId);
  return !!last && test(last.error);
}

// A task that failed on a git lock (`Unable to create '….lock': File exists`)
// that is STILL there after the fast-forward's retries and a stale-lock sweep
// will fail every remaining task the same way — on 2026-09-23 all 25 of a
// run's tasks errored on one abandoned index.lock. Halt once with the reason
// instead. Returns null when the failure was not a lock or the lock is gone.
async function persistentLockReason(
  run: MergeRun,
  projectPath: string,
  taskId: string,
): Promise<string | null> {
  const last = [...run.errored].reverse().find((e) => e.taskId === taskId);
  if (!last || !gitLockPathFromError(last.error)) return null;
  const { blocking } = await clearStaleGitLocks(projectPath);
  if (blocking.length === 0) return null;
  return `the project repo is locked by git: ${describeBlockingLocks(blocking)}`;
}
