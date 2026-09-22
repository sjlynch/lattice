// Headless control-flow steps for autonomous workflow runs.
//
// Agent steps (the existing kind) spawn a Claude/Pi/Codex in a terminal and
// advance when the Stop hook calls /api/workflow-runs/.../complete. Control
// steps are different: they don't spawn an agent at all. They run server-side
// against Lattice's own task pipeline:
//
//   - 'start' moves every Open task to In Progress and runs each (same code
//     path as the Task Board "Run All" button). One terminal tab is emitted
//     per task so the user can watch / intervene. (controlSteps/start.ts)
//   - 'merge' waits for In Progress to drain (Phase A), then triggers merge
//     runs until Ready-to-Merge is empty (Phase B). (controlSteps/merge.ts)
//   - 'push' waits for Ready-to-Merge to drain, then spawns a push session
//     (same code path as the Task Board cloud icon). (controlSteps/push.ts)
//
// This file is the thin dispatcher: it owns the per-project run-lock lifecycle
// and the kind→worker routing. The lane-wait subscription and progress
// notification helpers live in controlSteps/shared.ts; each per-kind worker
// lives in its own controlSteps/<kind>.ts module.
//
// Each control step acquires the per-project run-lock for its kind-specific
// worker so dev.mjs defers backend restarts while it's waiting, and a manual
// merge run can't race against the workflow. The lock is released BEFORE we
// call completeStep so the next step (often another control step) can
// acquire its own lock without racing the previous step's release.
//
// The orchestrator (workflowRuns.ts) dispatches to executeControlStep for
// non-agent steps. We take a `completeStep` callback rather than importing
// completeWorkflowStep directly to avoid the circular import — the
// orchestrator passes itself in.

import {
  acquireProjectRunLock,
  ProjectRunLockedError,
  type ProjectRunLockHandle,
} from '../projectRunLock.js';
import type { Workflow, WorkflowStepKind } from '../workflows.js';
import { checkpointWorkflowRun, notify, snapshot, type WorkflowRun } from './state.js';
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
};

const productionWorkerDeps: ControlStepWorkerDeps = {
  acquireLock: acquireProjectRunLock,
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
  const step = wf.steps[stepIndex];
  const kind: WorkflowStepKind = step.kind ?? 'agent';
  const lockLabel = `workflow-${kind}:${run.id}`;

  let lock: ProjectRunLockHandle | null = null;
  let workerError: Error | null = null;

  try {
    lock = await deps.acquireLock(wf.projectPath, lockLabel);
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
      workerError = new Error(err.message);
    } else {
      console.error(
        `[workflow-run] ${run.id} step ${stepIndex} (${kind}) ` +
          `acquire threw:`,
        err,
      );
      workerError = err as Error;
    }
  }

  if (!workerError && lock) {
    console.log(
      `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) starting`,
    );
    try {
      if (kind === 'start') {
        await deps.runStart(wf, run, stepIndex, backendOrigin);
      } else if (kind === 'merge') {
        await deps.runMerge(wf, run, stepIndex, backendOrigin);
      } else if (kind === 'push') {
        await deps.runPush(wf, run, stepIndex, backendOrigin);
      } else {
        throw new Error(`unsupported control-step kind: ${kind}`);
      }
    } catch (err) {
      workerError = err as Error;
    } finally {
      // Release the lock BEFORE calling completeStep. The next step (often
      // another control step) acquires its own lock; if we held this one
      // across completeStep the acquire would race against our release.
      await lock.release().catch(() => undefined);
      lock = null;
    }
  }

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
    run.status = 'errored';
    run.finishedAt = Date.now();
    run.error = workerError.message ?? 'control step failed';
    notify({ type: 'errored', run: snapshot(run) });
    // Make the terminal state durable NOW: `notify` only schedules the
    // debounced mirror, and a restart inside that window left the run
    // `running` on disk, so boot resume re-dispatched a finished control step.
    void checkpointWorkflowRun(run).catch(() => {});
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
    run.status = 'errored';
    run.finishedAt = Date.now();
    run.error = error?.message ?? 'advancing past control step failed';
    notify({ type: 'errored', run: snapshot(run) });
    void checkpointWorkflowRun(run).catch(() => {});
    console.error(
      `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) could not advance:`,
      err,
    );
  }
}
