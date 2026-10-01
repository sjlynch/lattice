// Boot-time resume for workflow runs interrupted by a backend restart.
//
// Sibling of `mergeRunResume.ts`, and for the same underlying reason: a run
// executes inside the backend process, and that process gets restarted
// routinely (`tsc -w` + the dev runner on any `backend/src` change, a crash,
// a processGuards fail-fast). `scripts/dev.mjs` defers a restart only while a
// per-project `run.lock` is held — which a workflow holds during CONTROL steps
// (start/merge/push) and NOT during agent steps. So the exposure window is the
// whole of every agent step, routinely 20+ minutes each.
//
// Before this module, that window silently destroyed the run:
//   1. `GET /api/workflow-runs/active` returned [] → the navbar chip vanished.
//   2. The step's agent kept working (its pty lives in the detached
//      terminal-server, which survives the restart) and eventually POSTed
//      `/api/workflow-runs/<id>/steps/<n>/complete`. `completeWorkflowStep`
//      found no run and returned silently — so the remaining steps (Start all
//      open tasks / Merge all / Push) never ran, with no error anywhere.
//
// `workflowRuns/persistence.ts` now mirrors every running run to
// `~/.lattice/per-project/<hash>/workflow-runs.json`; this reads that mirror on
// boot and applies `classifyWorkflowRunResume`'s decision per run. Runs AFTER
// the HTTP server is listening — a redispatched control step spawns agents that
// curl back into the API.

import { getWorkflow, type Workflow, type WorkflowStep } from '../workflows.js';
import {
  failWorkflowRun,
  getRun,
  redispatchCurrentWorkflowStep,
  restoreWorkflowRun,
  completeWorkflowStep,
  workflowStepCompletionAdvance,
} from '../workflowRuns.js';
import { loadPersistedWorkflowRuns } from '../workflowRuns/persistence.js';
import { activeStepIndices, heldStepStop, isWorkflowStepActive, setStepPhase, stepPhase, stepSessionId } from '../workflowRuns/execution.js';
import { notify, runs, snapshot } from '../workflowRuns/state.js';
import { requestStopHookStepComplete } from '../workflowRuns/stopHookGate.js';
import { waitForStepPreRunBegin } from '../workflowRuns/stepTools.js';
import { getActiveHookForProject } from '../postMergeHooks.js';
import { findCompletedPushRunForWorkflowStep, findRunningPushRunForWorkflowStep } from '../pushRuns.js';
import {
  classifyWorkflowRunResume,
  findStepSessionId,
  type ProbedSession,
} from '../workflowRuns/resumeDecision.js';
import { workflowStepDir } from '../workflowRuns/scratchDirectory.js';
import {
  adoptWorkflowStepSession,
  workflowStepAgentId,
} from '../workflowRuns/sessionSpawner.js';
import { registerAgentSession } from '../agentSessions.js';
import { effectiveStepHarness } from '../workflowRuns/stepMarkdown.js';
import { forgetAgentQuiescence, markAgentReadopted } from '../agentQuiescence.js';
import { proxyListSessionsOrNull } from '../terminalServerClient.js';
import type { WorkflowRun } from '../workflowRuns/state.js';
import { forEachKnownProjectSafely } from './projectIteration.js';
import { claimRecoveryAttempt } from './retryBudget.js';
import { listTasks, type Task, type TaskStatus } from '../tasks.js';
import {
  noteRunTestsStep,
  resumeRunTestsStep,
} from '../workflowRuns/testStep/runTestsStep.js';

export async function resumeInterruptedWorkflowRuns(
  backendOrigin: string,
  onRegistryReady: () => void = () => {},
): Promise<void> {
  // One terminal-server probe for the whole sweep. `null` means "couldn't
  // ask" — NOT "no sessions" — and the classifier treats it as such so a
  // wedged terminal-server can't mass-error every healthy run.
  const sessions = (await proxyListSessionsOrNull()) as ProbedSession[] | null;

  const recovered: WorkflowRun[] = [];
  await forEachKnownProjectSafely('resumeInterruptedWorkflowRuns', async (repoRoot) => {
    const persisted = await loadPersistedWorkflowRuns(repoRoot);
    // Install every sibling before the first redispatch can checkpoint this
    // project's file. Otherwise the first run's write loses its unloaded peers.
    const registered = registerPersistedWorkflowRuns(persisted, sessions);
    // A project runs one workflow at a time (`assertNoActiveWorkflowRun` 409s a
    // second start), but runs persisted by a build that still allowed parallel
    // workflows can come back as a pair. Resume them all — dropping one would
    // strand its tasks mid-pipeline — and just say so; it's a one-time
    // transition that the start gate prevents from recurring.
    if (registered.length > 1) {
      console.warn(
        `[startup] ${registered.length} workflow runs resumed for ${repoRoot}; they were ` +
          'started before one-run-per-project was enforced and will run concurrently until they finish.',
      );
    }
    recovered.push(...registered);
  });
  // Completion hooks can proceed once all records and surviving terminals are
  // registered; do not hold them behind scratch setup or redispatched workers.
  onRegistryReady();
  for (const run of recovered) {
    // Resolve once the run's dispatch decision is made and applied, not when
    // its re-dispatched agent step finishes its pre-run: a redispatch (or a
    // `complete` that dispatches the next step) awaits the step's pre-run tools
    // — an Opengrep scan, minutes — before it spawns, and the boot chain behind
    // this (outbox replay for EVERY project, merge-run resume, owed post-merge
    // hooks) must not wait on that. The resume keeps running detached.
    const preRun = waitForStepPreRunBegin(run.id);
    const resumed = resumePersistedRun(run, sessions, backendOrigin, true).catch((err) =>
      console.error(`[startup] workflow run ${run.id}: resume failed:`, err));
    try {
      await Promise.race([resumed, preRun.begun]);
    } finally {
      preRun.dispose();
    }
  }
}

export function registerPersistedWorkflowRuns(persisted: WorkflowRun[], sessions: ProbedSession[] | null): WorkflowRun[] {
  const registered: WorkflowRun[] = [];
  for (const run of persisted) {
    if (!restoreWorkflowRun(run)) continue;
    registered.push(run);
    for (const index of activeStepIndices(run)) {
      if (run.stepStates?.[index]?.phase === 'completed') continue;
      const stepDir = workflowStepDir(run.projectPath, run.id, index);
      const id = sessions ? findStepSessionId(sessions, stepDir, stepSessionId(run, index)) : null;
      if (id) adoptWorkflowStepSession(run.id, index, id);
      // A surviving (or unprobeable) session lost its live-subagent state.
      // Mark every member before callbacks are released at registry readiness.
      if (id || (sessions === null && stepPhase(run, index) !== 'pending')) {
        markAgentReadopted(workflowStepAgentId(run.id, index), heldStop({ ...run, currentStepIndex: index,
          stopReceived: heldStepStop(run, index) }));
      }
    }
  }
  return registered;
}

// Board lanes whose tasks a re-dispatched step may still act on — what the
// recovery checkpoint records and what a Merge/Push step can be waiting for.
const PENDING_TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'ready_to_merge'];

export async function resumePersistedRun(
  run: WorkflowRun,
  sessions: ProbedSession[] | null,
  backendOrigin: string,
  alreadyRestored = false,
  deps: { redispatchStep?: typeof redispatchCurrentWorkflowStep } = {},
): Promise<void> {
  const current = getRun(run.id);
  if (current && !alreadyRestored) return;
  if (alreadyRestored) {
    if (!current || current.status !== 'running' || current.currentStepIndex !== run.currentStepIndex) return;
    run = current;
  }

  const wf = run.definitionError ? null : run.definition ?? await getWorkflow(run.workflowId).catch(() => null);
  if (run.stepStates && run.activeStepIndices) {
    if (!wf) { failUnresumableRun(run, run.id, run.definitionError ?? 'workflow definition not found'); return; }
    if (run.activeStepIndices.every((i) => run.stepStates![i].phase === 'completed')) {
      restoreWorkflowRun(run);
      await completeWorkflowStep(run.id, run.currentStepIndex, backendOrigin, { resumeCompleted: true });
      return;
    }
    if (run.activeStepIndices.length > 1) {
      restoreWorkflowRun(run);
      await resumeParallelMembers(run, wf, sessions, backendOrigin, deps.redispatchStep ?? redispatchCurrentWorkflowStep);
      return;
    }
  }
  const step = wf?.steps[run.currentStepIndex] ?? null;
  const stepDir = workflowStepDir(run.projectPath, run.id, run.currentStepIndex);
  const serverId = sessions ? findStepSessionId(sessions, stepDir, run.stepSessionId) : null;

  const decision = classifyWorkflowRunResume({
    status: run.status,
    currentStepIndex: run.currentStepIndex,
    definitionStepCount: wf ? wf.steps.length : null,
    stepKind: step ? (step.kind ?? 'agent') : null,
    stepSessionAlive: sessions === null ? null : serverId !== null,
    stepPhase: run.stepPhase,
  });

  const label = `${run.id} "${run.workflowName}" step ${run.currentStepIndex + 1}/${run.totalSteps}`;
  // Only a re-adopted session keeps the "re-adopted" quiescence mark
  // registration may have put on it; a re-dispatched step gets a FRESH session
  // (no old subagents to wait for) and the other outcomes leave the step.
  if (decision.action !== 'readopt') {
    forgetAgentQuiescence(workflowStepAgentId(run.id, run.currentStepIndex));
  }
  if (decision.action === 'skip') return;

  if (decision.action === 'error') {
    failUnresumableRun(run, label, decision.reason);
    return;
  }

  restoreWorkflowRun(run);
  if (serverId) adoptWorkflowStepSession(run.id, run.currentStepIndex, serverId);

  switch (decision.action) {
    case 'complete':
      await completeWorkflowStep(run.id, run.currentStepIndex, backendOrigin);
      return;
    case 'advance':
      await advancePastLostTestStep(run, label, decision.reason, backendOrigin);
      return;
    case 'redispatch':
      await redispatchWithBudget(run, step, label, decision.reason, backendOrigin, deps.redispatchStep ?? redispatchCurrentWorkflowStep);
      return;
    case 'readopt':
      await readoptRun(run, wf, step, serverId, label, decision.reason, backendOrigin);
      return;
  }
}

async function resumeParallelMembers(run: WorkflowRun, wf: Workflow, sessions: ProbedSession[] | null,
  backendOrigin: string, redispatch: typeof redispatchCurrentWorkflowStep): Promise<void> {
  await Promise.all(activeStepIndices(run).map(async (index) => {
    if (run.stepStates?.[index]?.phase === 'completed') return;
    const latest = getRun(run.id);
    if (!latest || !isWorkflowStepActive(latest, index)) return;
    const step = wf.steps[index];
    if ((step.kind ?? 'agent') !== 'agent') { failUnresumableRun(run, run.id, 'action steps cannot run in parallel'); return; }
    const serverId = sessions ? findStepSessionId(sessions, workflowStepDir(run.projectPath, run.id, index), stepSessionId(latest, index)) : null;
    const member: WorkflowRun = { ...latest, currentStepIndex: index, stepPhase: stepPhase(latest, index),
      stepSessionId: stepSessionId(latest, index), stopReceived: heldStepStop(latest, index) };
    const decision = classifyWorkflowRunResume({ status: latest.status, currentStepIndex: index,
      definitionStepCount: wf.steps.length, stepKind: 'agent', stepPhase: member.stepPhase,
      stepSessionAlive: sessions === null ? null : serverId !== null });
    const label = `${run.id} "${run.workflowName}" step ${index + 1}/${run.totalSteps}`;
    if (decision.action !== 'readopt') forgetAgentQuiescence(workflowStepAgentId(run.id, index));
    if (decision.action === 'readopt') {
      await readoptRun(member, wf, step, serverId, label, decision.reason, backendOrigin);
    } else if (decision.action === 'complete') {
      if (serverId) adoptWorkflowStepSession(run.id, index, serverId);
      await completeWorkflowStep(run.id, index, backendOrigin);
    } else if (decision.action === 'error') {
      // Mark the actual lost member, rather than the group's anchor, in the UI.
      const live = getRun(run.id);
      if (live && isWorkflowStepActive(live, index)) {
        const state = runs.get(run.id)?.stepStates?.[index];
        if (state) { state.phase = 'errored'; state.error = decision.reason; }
        failUnresumableRun(run, label, decision.reason);
      }
    } else if (decision.action === 'redispatch') {
      const stillPending = () => {
        const live = getRun(run.id);
        return !!live && isWorkflowStepActive(live, index) && stepPhase(live, index) === 'pending';
      };
      try {
        const tasks = await listTasks(run.projectPath);
        const checkpoint = JSON.stringify([index, latest.activeStepIndices,
          Object.entries(getRun(run.id)?.stepStates ?? {}).map(([i, s]) => [i, s.phase]),
          tasks.filter((t) => PENDING_TASK_STATUSES.includes(t.status)).map((t) => [t.id, t.status, !!t.runQueued]).sort()]);
        const budget = await claimRecoveryAttempt(run.projectPath, `workflow:${run.id}:step:${index}`, checkpoint);
        if (!stillPending()) return;
        if (budget.paused) { failWorkflowRun(run.id, budget.paused); return; }
        forgetAgentQuiescence(workflowStepAgentId(run.id, index));
        await redispatch(run.id, backendOrigin, index);
      } catch (err) {
        if (stillPending()) failWorkflowRun(run.id, `Automatic recovery could not record its attempt: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }));
}

function failUnresumableRun(run: WorkflowRun, label: string, reason: string): void {
  // Restore first so the errored run actually reaches the UI (a run that was
  // never restored has nothing to mark errored, and the user would just see
  // it silently gone again).
  restoreWorkflowRun(run);
  console.warn(`[startup] workflow run ${label} cannot be resumed: ${reason}`);
  failWorkflowRun(run.id, `interrupted by a backend restart — ${run.definitionError ?? reason}`);
}

// A Run tests step whose agent is gone: note it on the step summary and move
// on — Run tests never stops the workflow.
async function advancePastLostTestStep(
  run: WorkflowRun,
  label: string,
  reason: string,
  backendOrigin: string,
): Promise<void> {
  console.warn(`[startup] workflow run ${label}: ${reason}; recording that and moving on.`);
  noteRunTestsStep(
    run,
    run.currentStepIndex,
    `Interrupted: ${reason}. Lattice moved on; whatever the agent committed before that stays committed.`,
    'lost',
  );
  await completeWorkflowStep(run.id, run.currentStepIndex, backendOrigin);
}

// Re-run the step that died with the old process, after charging the attempt
// to the recovery budget (unless it only waits on a live session).
async function redispatchWithBudget(
  run: WorkflowRun,
  step: WorkflowStep | null,
  label: string,
  reason: string,
  backendOrigin: string,
  redispatch: typeof redispatchCurrentWorkflowStep,
): Promise<void> {
  const recoveryStepIndex = run.currentStepIndex;
  const stillNeedsRedispatch = () => {
    const latest = getRun(run.id);
    return latest?.status === 'running' && latest.currentStepIndex === recoveryStepIndex
      && latest.stepPhase !== 'completing';
  };
  // Charge all automatic redispatch, including scratch preparation before
  // agent admission: a deterministic setup crash otherwise repeats forever.
  try {
    const tasks = await listTasks(run.projectPath);
    const pending = tasks.filter((t) => PENDING_TASK_STATUSES.includes(t.status));
    if (!isWaitingOnLiveSession(run, step, pending)) {
      const checkpoint = recoveryCheckpoint(run, step, pending);
      const budget = await claimRecoveryAttempt(run.projectPath, `workflow:${run.id}`, checkpoint);
      if (!stillNeedsRedispatch()) return;
      if (budget.paused) {
        failWorkflowRun(run.id, budget.paused);
        return;
      }
    }
  } catch (err) {
    if (!stillNeedsRedispatch()) return;
    failWorkflowRun(run.id, `Automatic recovery could not record its attempt; work was preserved: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // Readiness has been released, so a surviving hook may have completed this
  // step while the journal was being written. Never redispatch its successor
  // (or a completing step) using this stale recovery observation.
  if (!stillNeedsRedispatch()) return;
  console.warn(`[startup] workflow run ${label} interrupted — ${reason}; re-running it.`);
  await redispatch(run.id, backendOrigin).catch((err) =>
    console.error(`[startup] workflow run ${run.id}: redispatch failed:`, err),
  );
}

// Not a replay: the step's work is done and what it is re-run for is to wait
// on a LIVE session boot recovery just re-adopted — a Merge step whose merges
// all landed, waiting out its post-merge hook; a Push step re-attaching to its
// push session. The checkpoint (step + lanes) cannot move while that agent
// works, so charging these read "no progress" and paused a healthy run after
// three restarts (found by the soak). The budget's own rule: session adoption
// is not a replay attempt.
function isWaitingOnLiveSession(run: WorkflowRun, step: WorkflowStep | null, pending: Task[]): boolean {
  return (step?.kind === 'merge' &&
      !pending.some((t) => t.status === 'in_progress' || t.status === 'ready_to_merge') &&
      getActiveHookForProject(run.projectPath) !== null) ||
    (step?.kind === 'push' &&
      !pending.some((t) => t.status === 'ready_to_merge') &&
      (findRunningPushRunForWorkflowStep(run.id, run.currentStepIndex) !== undefined ||
        findCompletedPushRunForWorkflowStep(run.id, run.currentStepIndex) !== undefined));
}

// The recovery budget's notion of progress: the step, plus each pending task's
// lane and queued flag (sorted by id so board order doesn't count as a change).
function recoveryCheckpoint(run: WorkflowRun, step: WorkflowStep | null, pending: Task[]): string {
  return JSON.stringify([run.currentStepIndex, step?.id, pending
    .map((t) => [t.id, t.status, !!t.runQueued]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}

// readopt: the agent is still working. Re-attach its pty so the advance can
// reclaim it, and put its presence node back on the graph.
async function readoptRun(
  run: WorkflowRun,
  wf: Workflow | null,
  step: WorkflowStep | null,
  serverId: string | null,
  label: string,
  reason: string,
  backendOrigin: string,
): Promise<void> {
  const isStillActive = () => {
    const latest = getRun(run.id);
    return !!latest && isWorkflowStepActive(latest, run.currentStepIndex);
  };
  if (!isStillActive()) return;
  console.log(`[startup] workflow run ${label} re-adopted — ${reason}.`);
  if (serverId) adoptWorkflowStepSession(run.id, run.currentStepIndex, serverId);
  // Its subagents' state is unknown to this process: gate a Stop-hook advance
  // on the longer re-adopted settle window (idempotent with registration's).
  markAgentReadopted(workflowStepAgentId(run.id, run.currentStepIndex));
  if (step?.kind === 'test') {
    // Take the project run lock back (the dead backend's is stale) and re-arm
    // the step's timeout from its recorded spawn time.
    await resumeRunTestsStep(wf ?? undefined, run, run.currentStepIndex, backendOrigin, completeWorkflowStep);
  }
  if (!isStillActive()) return;
  const live = runs.get(run.id)!;
  const index = run.currentStepIndex;
  const changed = stepPhase(live, index) !== 'running' || (serverId && stepSessionId(live, index) !== serverId);
  setStepPhase(live, index, 'running');
  if (serverId) {
    if (live.stepStates?.[index]) live.stepStates[index].sessionId = serverId;
    if (live.currentStepIndex === index) live.stepSessionId = serverId;
  }
  if (changed) notify({ type: 'progress', run: snapshot(live) });
  if (wf && step) {
    registerAgentSession({
      agentId: workflowStepAgentId(run.id, run.currentStepIndex),
      projectPath: run.projectPath,
      label: `workflow step ${run.currentStepIndex + 1}`,
      // Same harness tag as the original spawn, so the re-adopted node keeps
      // its color.
      harness: effectiveStepHarness(wf, run, run.currentStepIndex),
    });
  }
  // The previous process had already received this step's Stop and was only
  // waiting out the quiescence gate when it died. The hook got its answer and
  // the agent is idle, so no second Stop is coming: re-arm the gate here or
  // the step never advances. Its quiet window counts from that Stop, or from
  // when the old gate last saw the session busy if later (registration passed
  // both to markAgentReadopted).
  if (heldStop(run)) {
    console.log(`[startup] workflow run ${label}: re-arming the completion gate for the Stop received before the restart.`);
    requestStopHookStepComplete(
      run.id,
      run.currentStepIndex,
      workflowStepCompletionAdvance(run.id, run.currentStepIndex, backendOrigin),
      undefined,
      { rearm: true },
    );
  }
}

// The Stop the gate was holding for the run's CURRENT step when the previous
// process went down (WorkflowRun.stopReceived), else undefined.
function heldStop(run: WorkflowRun): { stopAt: number; activeAt?: number; busy?: boolean } | undefined {
  const s = run.stopReceived;
  return s && s.stepIndex === run.currentStepIndex ? { stopAt: s.at, activeAt: s.activeAt, busy: s.busy } : undefined;
}
