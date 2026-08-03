// Pure decision layer for re-adopting a persisted workflow run after a backend
// restart. Kept free of IO so the policy is unit-testable; the IO wrapper lives
// in `../recovery/workflowRunResume.ts`.
//
// The three outcomes exist because a restart lands a run in one of three very
// different states:
//
//   readopt    — the current step is an AGENT step whose pty is still alive.
//                PTYs live in the detached terminal-server and survive a
//                backend restart, so the agent is still working and will POST
//                /complete when it stops. Restoring the run record is all that
//                is needed: the callback then advances the run exactly as if
//                nothing had happened. THIS is the case that strands a run
//                today (observed: a 7-step workflow lost at step 4/7 while its
//                Documentation agent was still running).
//   redispatch — the current step is a CONTROL step (start/merge/push). Those
//                execute inside the backend process, so the restart killed the
//                worker outright and no callback is ever coming. They are
//                written to be re-runnable (Start re-scans Open tasks, Merge
//                re-scans Ready-to-Merge, Push re-scans + respawns), which is
//                the same property `resumeInterruptedMergeRuns` relies on — so
//                run the step again.
//   error      — the current step is an agent step whose session is gone. The
//                agent exited while nobody was listening; we cannot know
//                whether it finished its work, and silently re-running a
//                completed 20-minute refactor step (or silently advancing past
//                an unfinished one) are both worse than telling the user. Mark
//                the run errored so the UI surfaces a failed run they can act
//                on instead of one that hangs forever.
//
// `stepSessionAlive: null` means "the terminal-server could not be probed" —
// deliberately treated as readopt, not error: a transient probe failure must
// never kill a healthy run (same "can't tell ≠ empty" rule the spawn queue and
// the recovery sweeps follow).

import path from 'node:path';
import type { WorkflowStepKind } from '../workflows.js';
import type { WorkflowRunStatus } from './state.js';

export type WorkflowResumeAction = 'readopt' | 'redispatch' | 'error' | 'skip';

export type WorkflowResumeDecision = {
  action: WorkflowResumeAction;
  reason: string;
};

export type WorkflowResumeInput = {
  status: WorkflowRunStatus;
  currentStepIndex: number;
  // Step count of the workflow DEFINITION as it exists now, or null when the
  // definition has been deleted/renamed out from under the run.
  definitionStepCount: number | null;
  // Kind of the run's current step, or null when it can't be resolved.
  stepKind: WorkflowStepKind | null;
  // true = pty found, false = definitively gone, null = couldn't probe.
  stepSessionAlive: boolean | null;
};

export function classifyWorkflowRunResume(
  input: WorkflowResumeInput,
): WorkflowResumeDecision {
  if (input.status !== 'running') {
    return { action: 'skip', reason: `run is ${input.status}, not running` };
  }
  if (input.definitionStepCount === null) {
    return { action: 'error', reason: 'workflow definition no longer exists' };
  }
  if (
    !Number.isInteger(input.currentStepIndex) ||
    input.currentStepIndex < 0 ||
    input.currentStepIndex >= input.definitionStepCount
  ) {
    return {
      action: 'error',
      reason:
        `current step ${input.currentStepIndex} is outside the workflow's ` +
        `${input.definitionStepCount} step(s) — the definition changed while the run was interrupted`,
    };
  }
  const kind = input.stepKind ?? 'agent';
  if (kind !== 'agent') {
    return {
      action: 'redispatch',
      reason: `${kind} control step was killed by the restart and is re-runnable`,
    };
  }
  if (input.stepSessionAlive === false) {
    return {
      action: 'error',
      reason:
        'the agent step\'s terminal session did not survive the backend restart, ' +
        'so its completion callback can never arrive',
    };
  }
  return {
    action: 'readopt',
    reason:
      input.stepSessionAlive === null
        ? 'terminal-server could not be probed — assuming the agent step is still running'
        : 'the agent step\'s terminal session is still alive',
  };
}

// ---------------------------------------------------------------------------
// Session matching
// ---------------------------------------------------------------------------

export type ProbedSession = { id?: unknown; cwd?: unknown };

function comparablePath(p: string): string {
  const resolved = path.resolve(p);
  // Windows paths are case-insensitive; the terminal-server echoes back the
  // exact cwd string it was handed, but a drive-letter or separator difference
  // must not read as "session gone" (which would error a healthy run).
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Find the live pty whose cwd is a workflow step's scratch dir. Returns the
// session id, or null when no session matches. `sessions` is the raw
// terminal-server payload, so every field is treated as untrusted.
export function findStepSessionId(
  sessions: readonly ProbedSession[],
  stepDir: string,
): string | null {
  const want = comparablePath(stepDir);
  for (const s of sessions) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.cwd !== 'string' || typeof s.id !== 'string' || !s.id) continue;
    if (comparablePath(s.cwd) === want) return s.id;
  }
  return null;
}
