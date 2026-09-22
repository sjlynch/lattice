import {
  gitDirExists,
  projectGit,
} from '../worktree.js';
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

  return outcome;
}
