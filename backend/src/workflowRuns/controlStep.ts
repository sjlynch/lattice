// Headless control-flow steps for autonomous workflow runs. Unlike agent steps
// (spawn a harness, advance on its Stop hook's /complete), control steps spawn
// no agent and run server-side against Lattice's own task pipeline:
//   - 'start': every Open task → In Progress and run (the Task Board "Run All"
//     path), one terminal tab per task. (controlSteps/start.ts)
//   - 'merge': wait for In Progress to drain (Phase A), then merge runs until
//     Ready-to-Merge is empty (Phase B). (controlSteps/merge.ts)
//   - 'push': wait for Ready-to-Merge to drain, then spawn a push session (the
//     Task Board cloud-icon path). (controlSteps/push.ts)
// This file is the dispatcher (run-lock lifecycle + kind→worker routing); lane
// waits and progress helpers live in controlSteps/shared.ts.
//
// Each step holds the per-project run-lock so dev.mjs defers backend restarts
// while it waits and a manual merge run can't race the workflow. The lock is
// released BEFORE `completeStep` so the next (often control) step can acquire
// its own without racing; the release → advance hand-off is covered by a
// restart-drain transition instead (`runControlStepWorker`, ../restartDrain/),
// so a restart that sees the lock vanish still waits for the advance to land.
// `completeStep` is passed in by the orchestrator (workflowRuns.ts) to avoid a
// circular import.

import {
  acquireProjectRunLock,
  ProjectRunLockedError,
  type ProjectRunLockHandle,
} from '../projectRunLock.js';
import type { Workflow, WorkflowStepKind } from '../workflows.js';
import { waitForRepoMaintenance } from '../worktree/repoMaintenance.js';
import { beginRestartTransition } from '../restartDrain/gate.js';
import type { WorkflowRun } from './state.js';
import { markRunErrored } from './runErrored.js';
import { runStartStep } from './controlSteps/start.js';
import { runMergeStep } from './controlSteps/merge.js';
import { runPushStep } from './controlSteps/push.js';

export type CompleteStepCallback = (
  runId: string,
  stepIndex: number,
  backendOrigin: string,
) => Promise<void>;

// Injectable seam (production default below). The lock lifecycle — acquire,
// then release in the `finally` even when the per-kind worker throws — is the
// critical invariant this file owns: every wait inside a control step MUST be
// bounded (see waitForLaneEmpty's Fix 2 timeout) or the lock leaks. The
// regression test overrides these to make a worker throw and assert the lock's
// release() still runs (the run.lock is freed) and the step does not advance.
export type ControlStepWorkerDeps = {
  acquireLock: typeof acquireProjectRunLock;
  runStart: typeof runStartStep;
  runMerge: typeof runMergeStep;
  runPush: typeof runPushStep;
  // Resolves once the project's post-merge-run `git gc --auto` housekeeping
  // is done (bounded by the gc's own timeout). Defaults to the real one.
  waitForRepoMaintenance?: (projectPath: string) => Promise<boolean>;
};

const productionWorkerDeps: ControlStepWorkerDeps = {
  acquireLock: acquireProjectRunLock,
  waitForRepoMaintenance: (p) => waitForRepoMaintenance(p),
  runStart: runStartStep,
  runMerge: runMergeStep,
  runPush: runPushStep,
};

// Fire-and-forget orchestration entry point. Mirrors spawnWorkflowStep's
// shape (called by the orchestrator, returns quickly) but the long-running
// work continues in a worker that calls completeStep itself when done.
export function executeControlStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  completeStep: CompleteStepCallback,
): void {
  // Backstop: the worker guards every await it owns, but an unobserved
  // rejection here would reach processGuards' unhandledRejection handler and
  // take the whole backend down.
  runControlStepWorker(wf, run, stepIndex, backendOrigin, completeStep).catch((err) => {
    console.error(
      `[workflow-run] ${run.id} control step ${stepIndex} worker rejected:`,
      err,
    );
  });
}

export async function runControlStepWorker(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  completeStep: CompleteStepCallback,
  deps: ControlStepWorkerDeps = productionWorkerDeps,
): Promise<void> {
  // The lock hand-off (release → completeStep) is marked as a restart-drain
  // transition from just BEFORE the release until the advance returns. The dev
  // runner defers restarts on the run.lock file, which disappears at the
  // release; without this there would be an instant where neither the lock
  // nor anything else said "mid-transition" and a restart could land in the
  // advance. (Holding the lock across completeStep instead is not an option:
  // the next control step acquires its own lock from inside that call.)
  const handoff = { end: () => {} };
  try {
    await runControlStepWorkerLocked(wf, run, stepIndex, backendOrigin, completeStep, deps, handoff);
  } finally {
    handoff.end();
  }
}

async function runControlStepWorkerLocked(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  completeStep: CompleteStepCallback,
  deps: ControlStepWorkerDeps,
  handoff: { end: () => void },
): Promise<void> {
  const step = wf.steps[stepIndex];
  const kind: WorkflowStepKind = step.kind ?? 'agent';

  const acquired = await acquireControlStepLock(wf, run, stepIndex, kind, deps);
  let workerError: Error | null = 'error' in acquired ? acquired.error : null;
  const lock = 'lock' in acquired ? acquired.lock : null;

  if (!workerError && lock) {
    console.log(
      `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) starting`,
    );
    try {
      await runControlStepKind(kind, deps, wf, run, stepIndex, backendOrigin);
    } catch (err) {
      workerError = err as Error;
    } finally {
      // Release the lock BEFORE calling completeStep. The next step (often
      // another control step) acquires its own lock; if we held this one
      // across completeStep the acquire would race against our release.
      handoff.end = beginRestartTransition(`workflow ${run.id} control step ${stepIndex} (${kind}) hand-off`);
      await lock.release().catch(() => undefined);
    }
  }

  await settleControlStep(run, stepIndex, kind, backendOrigin, completeStep, workerError);
}

// Phase 1: wait out repo maintenance, then take the per-project run lock.
// `{ lock: null }` means the run was cancelled during the wait (no lock taken;
// settleControlStep's not-running branch returns). `{ error }` carries the
// failure into settleControlStep, same as a worker throw.
async function acquireControlStepLock(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  kind: WorkflowStepKind,
  deps: ControlStepWorkerDeps,
): Promise<{ lock: ProjectRunLockHandle | null } | { error: Error }> {
  const lockLabel = `workflow-${kind}:${run.id}`;
  try {
    // A merge run's housekeeping gc may be repacking right now (it holds the
    // run lock while it does). Wait for it rather than failing the step on the
    // lock: the gc is bounded, and merging beside a repack is what leaves a
    // full leftover pack copy on Windows. If it is somehow still running after
    // the bound, the acquire below refuses with a message naming it.
    const waitForMaintenance = deps.waitForRepoMaintenance ?? ((p: string) => waitForRepoMaintenance(p));
    if (!(await waitForMaintenance(wf.projectPath))) {
      console.warn(`[workflow-run] ${run.id} step ${stepIndex} (${kind}) git housekeeping still running after the wait bound`);
    }
    // Cancelled during that wait: take no lock; the not-running branch in
    // settleControlStep returns.
    if (run.status !== 'running') return { lock: null };
    return { lock: await deps.acquireLock(wf.projectPath, lockLabel) };
  } catch (err) {
    if (err instanceof ProjectRunLockedError) {
      // Log loud — historically this is the most common reason a workflow
      // appears to "abort right after step N": a previous run's lock
      // wasn't cleared (dev restart, stuck hook, etc.). The wrapped
      // message goes into run.error and is also surfaced via WS.
      console.warn(
        `[workflow-run] ${run.id} step ${stepIndex} (${kind}) ` +
          `could not acquire project run lock: ${err.message}`,
      );
      return { error: new Error(err.message) };
    }
    console.error(
      `[workflow-run] ${run.id} step ${stepIndex} (${kind}) ` +
        `acquire threw:`,
      err,
    );
    return { error: err as Error };
  }
}

// Phase 2: kind → per-kind worker. Looked up by deps key and called as a
// method so an injected deps object sees the same call it always did.
const CONTROL_STEP_RUNNERS: Partial<Record<WorkflowStepKind, 'runStart' | 'runMerge' | 'runPush'>> = {
  start: 'runStart',
  merge: 'runMerge',
  push: 'runPush',
};

async function runControlStepKind(
  kind: WorkflowStepKind,
  deps: ControlStepWorkerDeps,
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<void> {
  const runner = CONTROL_STEP_RUNNERS[kind];
  if (!runner) throw new Error(`unsupported control-step kind: ${kind}`);
  await deps[runner](wf, run, stepIndex, backendOrigin);
}

// Phase 3 (the lock is already released): error the run on a worker failure,
// stop on a cancelled run, otherwise advance.
async function settleControlStep(
  run: WorkflowRun,
  stepIndex: number,
  kind: WorkflowStepKind,
  backendOrigin: string,
  completeStep: CompleteStepCallback,
  workerError: Error | null,
): Promise<void> {
  if (workerError) {
    if (run.status !== 'running') {
      // The run was already cancelled (or otherwise finished) while the worker
      // was in flight — a cancel during a pending `acquireLock`, say, whose
      // acquire then throws. That terminal state stands; don't clobber it with
      // `errored` and emit a second terminal event.
      console.log(
        `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) failed after the run ended in ${run.status}; keeping that state:`,
        workerError.message,
      );
      return;
    }
    // markRunErrored checkpoints the terminal state NOW: `notify` only
    // schedules the debounced mirror, and a restart inside that window left
    // the run `running` on disk, so boot resume re-dispatched a finished
    // control step.
    markRunErrored(run, workerError.message ?? 'control step failed');
    console.error(
      `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) failed:`,
      workerError,
    );
    return;
  }

  if (run.status !== 'running') {
    // Workflow run was cancelled mid-step. Don't advance.
    console.log(
      `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) ended in ${run.status}; not advancing`,
    );
    return;
  }

  console.log(
    `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) finished, advancing`,
  );
  // completeStep (completeWorkflowStep) can reject — a definition error, or
  // the run checkpoint's atomic write failing (EPERM under an AV scanner,
  // ENOSPC). This is a detached worker: without the catch that rejection is
  // unhandled and processGuards exits the process, killing every other run.
  // Error the run the same way a failed worker does instead.
  try {
    await completeStep(run.id, stepIndex, backendOrigin);
  } catch (err) {
    const error = err as Error | undefined;
    // A cancel that lands while the advance is in flight (its `completing`
    // checkpoint write, say) stands — same rule as the worker-error path.
    if (run.status !== 'running') {
      console.log(
        `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) advance failed after the run ended in ${run.status}; keeping that state:`,
        error?.message,
      );
      return;
    }
    markRunErrored(run, error?.message ?? 'advancing past control step failed');
    console.error(
      `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) could not advance:`,
      err,
    );
  }
}
