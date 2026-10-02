// The Run tests step's hold on the project and its clock: the non-lendable
// project run lock (waited for while something else holds it) and the timeout,
// armed when the pty actually spawns.

import { RUN_TESTS_LOCK_LABEL_PREFIX, type ProjectRunLockHandle } from '../../projectRunLock.js';
import type { WorkflowRunEvent } from '../state.js';
import { workflowStepDir } from '../scratchDirectory.js';
import { readUserWipFile, wipCovers } from './userWip.js';
import {
  isCurrent,
  progress,
  type ActiveRunTestsStep,
  type RunTestsOutcome,
} from './runTestsLifecycle.js';
import type { RunTestsDeps } from './runTestsStep.js';

export const MINUTE_MS = 60_000;

// What this module needs from the orchestrator. `deps` is read at each use,
// never captured: the lock wait and the timers outlive the call, and tests swap
// the IO with `setRunTestsDepsForTest`.
export type LockWaitContext = {
  deps: () => RunTestsDeps;
  noteAndAdvance: (entry: ActiveRunTestsStep, note: string, outcome: RunTestsOutcome) => Promise<void>;
};

export function runTestsLockLabel(runId: string): string {
  return `${RUN_TESTS_LOCK_LABEL_PREFIX}${runId}`;
}

// Take the project run lock (non-lendable), waiting while something else holds
// it — a manual merge that is finishing, say. Gives up after `lockWaitMs` with
// the reason, so the caller can note + skip instead of hanging.
export async function acquireWithWait(
  ctx: LockWaitContext,
  entry: ActiveRunTestsStep,
): Promise<ProjectRunLockHandle | { gaveUp: string } | null> {
  const { run, stepIndex } = entry;
  const started = Date.now();
  let announced = false;
  for (;;) {
    if (!isCurrent(run, stepIndex)) return null;
    const deps = ctx.deps();
    try {
      return await deps.acquireLock(run.projectPath, runTestsLockLabel(run.id), { lendable: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (Date.now() - started >= deps.lockWaitMs) return { gaveUp: message };
      if (!announced) {
        announced = true;
        progress(run, stepIndex, 'waiting for the project to be free (a merge is holding it)…');
        console.log(`[workflow-run] ${run.id} Run tests step ${stepIndex}: waiting for the project run lock — ${message}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, deps.lockRetryMs);
        t.unref?.();
      });
    }
  }
}

// The lock wait's give-up note. Real minutes — not `deps.minuteMs`, the timeout
// unit tests shrink.
export function lockGaveUpNote(ctx: LockWaitContext, reason: string): string {
  return `Skipped: the project stayed busy for ${Math.round(ctx.deps().lockWaitMs / MINUTE_MS)} minutes — ${reason}`;
}

export function armTimeout(ctx: LockWaitContext, entry: ActiveRunTestsStep, spawnedAt: number): void {
  if (entry.timer) clearTimeout(entry.timer);
  const remaining = Math.max(0, entry.timeoutMs - (Date.now() - spawnedAt));
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void onTimeout(ctx, entry).catch((err) => {
      console.error(`[workflow-run] ${entry.run.id} Run tests step ${entry.stepIndex}: timeout handling failed:`, err);
    });
  }, remaining);
  entry.timer.unref?.();
}

async function onTimeout(ctx: LockWaitContext, entry: ActiveRunTestsStep): Promise<void> {
  const { run, stepIndex } = entry;
  if (entry.finalized || !isCurrent(run, stepIndex)) return;
  const minutes = Math.round(entry.timeoutMs / ctx.deps().minuteMs);
  await ctx.deps().killStepSession(run.id, stepIndex).catch(() => {});
  const stepDir = workflowStepDir(run.projectPath, run.id, stepIndex);
  const wip = (await readUserWipFile(stepDir)) ?? [];
  const now = await ctx.deps().readStatus(run.projectPath);
  const leftovers = now ? now.filter((p) => !wipCovers(wip, p)) : null;
  const lines = [
    `**Timed out after ${minutes} minute(s)** — Lattice stopped the session and moved on.`,
  ];
  if (leftovers === null) {
    lines.push('Lattice could not read `git status` to list what it left uncommitted.');
  } else if (leftovers.length === 0) {
    lines.push('It left no uncommitted changes outside your own work in progress.');
  } else {
    lines.push(
      `It changed ${leftovers.length} file(s) without committing them. They were left exactly as they are — nothing was reverted:`,
      ...leftovers.slice(0, 50).map((p) => `- \`${p}\``),
      ...(leftovers.length > 50 ? [`- … and ${leftovers.length - 50} more`] : []),
    );
  }
  await ctx.noteAndAdvance(entry, lines.join('\n'), 'timeout');
}

// Before the spawn: the timeout runs from the moment the pty exists, not from
// now — the spawn may sit in the spawn queue behind the resource governor for a
// while. The step's `step-spawned` records `spawnedAt` (so a re-adopting
// backend re-arms the remainder) and arms the timer.
export function armTimeoutOnSpawn(ctx: LockWaitContext, entry: ActiveRunTestsStep): void {
  const { run, stepIndex } = entry;
  entry.unsubscribe = ctx.deps().subscribeRuns((ev: WorkflowRunEvent) => {
    if (ev.type !== 'step-spawned' || ev.runId !== run.id || ev.stepIndex !== stepIndex) return;
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
    if (entry.finalized) return;
    const spawnedAt = Date.now();
    if (run.testStep?.stepIndex === stepIndex) {
      run.testStep.spawnedAt = spawnedAt;
      void ctx.deps().checkpoint(run).catch(() => {});
    }
    armTimeout(ctx, entry, spawnedAt);
  });
}
