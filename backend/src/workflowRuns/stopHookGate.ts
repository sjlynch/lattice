// Quiescence gate for the Claude Stop-hook step-completion callback.
//
// Why this exists: a workflow step advances when its agent's session ends,
// which for a Claude step is detected by the `Stop` hook POSTing
// `/api/workflow-runs/:runId/steps/:n/complete`. But Claude's `Stop` hook is
// not a reliable "session fully done" signal when the step agent uses the Task
// tool — it fires early and repeatedly (reproduced: a Stop landing while a
// subagent was still running, ~8s before the session truly ended). The FIRST
// such premature Stop used to advance the run immediately, spawning step N+1
// while step N's agent kept working → the steps ran in parallel (intermittent,
// exactly "sometimes the steps overlap").
//
// The fix, applied only to the Stop-hook-sourced completion (the model's own
// explicit curl and Pi's session_shutdown extension are intentional end-of-work
// signals and keep advancing immediately): don't advance on the Stop itself.
// Instead wait until the session is QUIESCENT — no subagents in flight and no
// signal of any kind (tool use, subagent start/stop, or a later Stop) for a
// short settle window. Because the real Stop always arrives last and premature
// Stops are followed by more activity and/or the final Stop, the quiet window
// lands on the genuine end of the step. `agentQuiescence.ts` supplies the
// per-session liveSubagents / lastSignalAt this reads; the activity route feeds
// it from the very hooks that already drive the graph.

import { checkpointWorkflowRun, getRun, notify, runs, snapshot } from './state.js';
import { isWorkflowStepActive, heldStepStop } from './execution.js';
import { workflowStepAgentId } from './sessionSpawner.js';
import { agentHeldActivity, isAgentQuiescent, noteAgentSignal, noteAgentStop } from '../agentQuiescence.js';
import { isRunTestsStep, noteRunTestsStep } from './testStep/runTestsStep.js';

// Advance only after the session has been fully quiet (no subagents live, no
// signal) for this long. Long enough to bridge the gap between a premature Stop
// and the real one, short enough to add only a small tail to a step's runtime.
export const STOP_HOOK_SETTLE_MS = 4000;
// How often to re-check quiescence while waiting.
export const STOP_HOOK_POLL_MS = 1000;
// A Run tests step never parks on a failed completion checkpoint (it must never
// stop the workflow): after the usual three attempts it keeps retrying at this
// slower cadence until the advance lands (or the step's own timeout does it).
export const RUN_TESTS_GATE_RETRY_MS = 30_000;

type GateTiming = { settleMs: number; pollMs: number; runTestsRetryMs?: number };

type PendingGate = {
  stepIndex: number;
  timer: ReturnType<typeof setTimeout>;
};

// One pending gate per run/member. Every tick re-checks active membership,
// so a stale gate clears itself without affecting its parallel siblings.
const pending = new Map<string, PendingGate>();

function clearGate(runId: string): void {
  heldActivityPersistedAt.delete(runId);
  const g = pending.get(runId);
  if (g) {
    clearTimeout(g.timer);
    pending.delete(runId);
  }
}

// Request a Stop-hook-driven advance of (runId, stepIndex). Idempotent and
// safe to call repeatedly as duplicate/premature Stops arrive: each call feeds
// the Stop in as a fresh signal (extending the settle window) but only one
// poll loop runs per member. `advance` is invoked at most once, when the session
// goes quiescent while this step is still active.
export function requestStopHookStepComplete(
  runId: string,
  stepIndex: number,
  advance: () => void | Promise<void>,
  timing: GateTiming = { settleMs: STOP_HOOK_SETTLE_MS, pollMs: STOP_HOOK_POLL_MS },
  // `rearm`: a re-adopting backend restarting the gate for a Stop the previous
  // process had received (WorkflowRun.stopReceived) — not a new Stop, so it
  // must not restart the quiet window at "now".
  opts: { rearm?: boolean } = {},
): void {
  const key = `${runId}:${stepIndex}`;
  const run = getRun(runId);
  // Same idempotency guard as completeWorkflowStep: ignore a Stop for a run
  // that isn't running or a step that is no longer current (a late final Stop
  // for a step we already advanced past).
  if (!run || !isWorkflowStepActive(run, stepIndex)) return;

  const agentId = workflowStepAgentId(runId, stepIndex);
  // Count this Stop as a signal so the settle window is measured from the most
  // recent Stop, not just from tool/subagent activity — repeated Stops keep
  // pushing the window out until they stop coming.
  if (!opts.rearm) noteAgentStop(agentId);

  const existing = pending.get(key);
  if (existing && existing.stepIndex === stepIndex) return; // poll already running

  let failures = 0;
  const tick = (): void => {
    const r = getRun(runId);
    if (!r || !isWorkflowStepActive(r, stepIndex)) {
      clearGate(key);
      return;
    }
    if (isAgentQuiescent(agentId, timing.settleMs)) {
      const active = pending.get(key);
      void Promise.resolve().then(advance).then(() => {
        if (pending.get(key) === active) clearGate(key);
      }, (err) => {
        if (pending.get(key) !== active) return;
        const current = runs.get(runId);
        if (!current || !isWorkflowStepActive(current, stepIndex)) {
          clearGate(key);
          return;
        }
        failures += 1;
        console.error(`[workflow-run] ${runId} gated completion attempt ${failures} failed:`, err);
        if (failures >= 3 && isRunTestsStep(current, stepIndex)) {
          if (failures === 3) {
            noteRunTestsStep(
              current,
              stepIndex,
              `Lattice could not save this step's completion after 3 attempts (${err instanceof Error ? err.message : String(err)}) and kept retrying.`,
            );
          }
          noteAgentSignal(agentId);
          schedule(timing.runTestsRetryMs ?? RUN_TESTS_GATE_RETRY_MS);
          return;
        }
        if (failures >= 3) {
          current.error = 'Workflow completion could not be saved after 3 attempts; work was preserved. Retry the completion after fixing the persistence error.';
          notify({ type: 'progress', run: snapshot(current) });
          clearGate(key);
          return;
        }
        // Re-evaluate quiescence on every retry. A subagent may have resumed
        // during the failed write; elapsed time alone never authorizes advance.
        noteAgentSignal(agentId);
        schedule();
      });
      return;
    }
    // Still working (subagent live, turn owed, or a recent signal). Persist
    // when it was last seen busy, so a restart re-arms this gate from THAT
    // rather than from the Stop (see agentQuiescence.ts markAgentReadopted).
    noteHeldStopActivity(runId, stepIndex, agentId);
    schedule(); // keep waiting
  };

  const schedule = (delayMs: number = timing.pollMs): void => {
    const timer = setTimeout(tick, delayMs);
    timer.unref?.();
    pending.set(key, { stepIndex, timer });
  };

  // Replace any stale gate (defensive — a gate for a prior step should already
  // have cleared itself on its guard) and start the poll loop.
  clearGate(key);
  schedule();
}

// Durably note that a Stop for (runId, stepIndex) is now held by the gate, so a
// restart before the gate fires re-arms it instead of losing the completion
// (see WorkflowRun.stopReceived). Awaited BEFORE the hook gets its 200: once
// the hook has an answer nothing will ever send this Stop again. A failed
// write is logged, not thrown — the in-memory gate still runs; only its
// survival across a restart is lost.
export async function recordStopReceived(runId: string, stepIndex: number): Promise<void> {
  // The live record, not `getRun` (which hands out a snapshot copy).
  const run = runs.get(runId);
  if (!run || !isWorkflowStepActive(run, stepIndex)) return;
  const stop = { stepIndex, at: Date.now() };
  if (run.stepStates?.[stepIndex]) run.stepStates[stepIndex].stopReceived = stop;
  if (run.currentStepIndex === stepIndex) run.stopReceived = stop;
  await checkpointWorkflowRun(run).catch((err) =>
    console.warn(`[workflow-run] ${runId} could not record the Stop for step ${stepIndex}:`, err),
  );
}

// Throttle for persisting a holding gate's last-busy time: a restart re-arms
// from a value at most this stale, well inside READOPTED_SETTLE_MS.
export const HELD_STOP_ACTIVITY_PERSIST_MS = 15_000;
const heldActivityPersistedAt = new Map<string, number>();

function noteHeldStopActivity(runId: string, stepIndex: number, agentId: string): void {
  const run = runs.get(runId);
  const held = run ? heldStepStop(run, stepIndex) : undefined;
  if (!run || !held || held.stepIndex !== stepIndex) return;
  const key = `${runId}:${stepIndex}`;
  const now = Date.now();
  if (now - (heldActivityPersistedAt.get(key) ?? 0) < HELD_STOP_ACTIVITY_PERSIST_MS) return;
  const { activeAt, busy } = agentHeldActivity(agentId, HELD_STOP_ACTIVITY_PERSIST_MS);
  if (activeAt <= (held.activeAt ?? held.at)) return;
  heldActivityPersistedAt.set(key, now);
  held.activeAt = activeAt;
  held.busy = busy;
  void checkpointWorkflowRun(run).catch(() => {});
}

// Cancel a pending gate (run cancelled). No-op if none is pending.
export function cancelStopHookGate(runId: string, stepIndex?: number): void {
  if (stepIndex !== undefined) { clearGate(`${runId}:${stepIndex}`); return; }
  for (const key of pending.keys()) if (key.startsWith(`${runId}:`)) clearGate(key);
}
