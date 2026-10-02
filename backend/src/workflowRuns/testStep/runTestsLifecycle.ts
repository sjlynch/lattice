// Internal entry tracking, the step helpers its phases share, and resource
// cleanup for the Run tests step. Orchestration and injected IO dependencies
// stay in runTestsStep.ts.

import type { ProjectRunLockHandle } from '../../projectRunLock.js';
import type { WorkflowRun } from '../state.js';
import { emitControlProgress } from '../controlSteps/shared.js';

export type CompleteStepCallback = (
  runId: string,
  stepIndex: number,
  backendOrigin: string,
) => Promise<void>;

// How the step ended, as far as the summary / run-tests.json care:
//   agent    — the agent's own completion (the default when nothing else set it)
//   skipped  — never needed to run (HEAD unchanged, detached HEAD, lock busy)
//   not-run  — could not start (setup threw, the spawn failed)
//   timeout  — the session was killed after `timeoutMinutes`
//   lost     — the terminal did not survive a backend restart
// Only `agent` records run-tests.json: a run that didn't finish verified nothing,
// so the next Run tests must not skip on its account.
export type RunTestsOutcome = 'agent' | 'skipped' | 'not-run' | 'timeout' | 'lost';

export type ActiveRunTestsStep = {
  run: WorkflowRun;
  stepIndex: number;
  backendOrigin: string;
  completeStep: CompleteStepCallback | null;
  lock: ProjectRunLockHandle | null;
  timeoutMs: number;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  notes: string[];
  outcome: RunTestsOutcome;
  finalized: boolean;
};

export function isCurrent(run: WorkflowRun, stepIndex: number): boolean {
  return run.status === 'running' && run.currentStepIndex === stepIndex;
}

export function progress(run: WorkflowRun, stepIndex: number, message: string): void {
  emitControlProgress(run, stepIndex, 'test', 0, 0, message);
}

// One Run tests step in flight per run (a run has one current step).
const activeSteps = new Map<string, ActiveRunTestsStep>();

export function beginEntry(
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  completeStep: CompleteStepCallback | null,
  timeoutMs: number,
): ActiveRunTestsStep {
  const previous = activeSteps.get(run.id);
  if (previous) void teardownEntry(previous);
  const entry: ActiveRunTestsStep = {
    run,
    stepIndex,
    backendOrigin,
    completeStep,
    lock: null,
    timeoutMs,
    notes: [],
    outcome: 'agent',
    finalized: false,
  };
  activeSteps.set(run.id, entry);
  return entry;
}

export function entryFor(runId: string, stepIndex: number): ActiveRunTestsStep | undefined {
  const entry = activeSteps.get(runId);
  return entry && entry.stepIndex === stepIndex ? entry : undefined;
}

export function entryForRun(runId: string): ActiveRunTestsStep | undefined {
  return activeSteps.get(runId);
}

export function hasEntry(runId: string): boolean {
  return activeSteps.has(runId);
}

// Stop watchers while keeping the entry and lock through finalization's
// summary and run-tests.json recording.
export function stopEntryWatchers(entry: ActiveRunTestsStep): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.unsubscribe?.();
  entry.unsubscribe = undefined;
}

// Stop the timer + subscription and release the lock. Idempotent.
export async function teardownEntry(entry: ActiveRunTestsStep): Promise<void> {
  stopEntryWatchers(entry);
  const lock = entry.lock;
  entry.lock = null;
  if (activeSteps.get(entry.run.id) === entry) activeSteps.delete(entry.run.id);
  if (lock) {
    await lock.release().catch((err) => {
      console.warn(`[workflow-run] ${entry.run.id} Run tests step ${entry.stepIndex}: releasing the project run lock failed:`, err);
    });
  }
}
