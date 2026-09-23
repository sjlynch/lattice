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

import { getWorkflow } from '../workflows.js';
import {
  failWorkflowRun,
  getRun,
  redispatchCurrentWorkflowStep,
  restoreWorkflowRun,
  completeWorkflowStep,
} from '../workflowRuns.js';
import { loadPersistedWorkflowRuns } from '../workflowRuns/persistence.js';
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
import { effectiveStepHarness } from '../workflowRuns/stepMarkdown.js';
import { registerAgentSession } from '../agentSessions.js';
import { proxyListSessionsOrNull } from '../terminalServerClient.js';
import type { WorkflowRun } from '../workflowRuns/state.js';
import { forEachKnownProjectSafely } from './projectIteration.js';
import { claimRecoveryAttempt } from './retryBudget.js';
import { listTasks } from '../tasks.js';

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
    await resumePersistedRun(run, sessions, backendOrigin, true).catch((err) =>
      console.error(`[startup] workflow run ${run.id}: resume failed:`, err));
  }
}

export function registerPersistedWorkflowRuns(persisted: WorkflowRun[], sessions: ProbedSession[] | null): WorkflowRun[] {
  const registered: WorkflowRun[] = [];
  for (const run of persisted) {
    if (!restoreWorkflowRun(run)) continue;
    registered.push(run);
    const stepDir = workflowStepDir(run.projectPath, run.id, run.currentStepIndex);
    const id = sessions ? findStepSessionId(sessions, stepDir, run.stepSessionId) : null;
    if (id) adoptWorkflowStepSession(run.id, run.currentStepIndex, id);
  }
  return registered;
}

export async function resumePersistedRun(
  run: WorkflowRun,
  sessions: ProbedSession[] | null,
  backendOrigin: string,
  alreadyRestored = false,
): Promise<void> {
  const current = getRun(run.id);
  if (current && !alreadyRestored) return;
  if (alreadyRestored) {
    if (!current || current.status !== 'running' || current.currentStepIndex !== run.currentStepIndex) return;
    run = current;
  }

  const wf = run.definitionError ? null : run.definition ?? await getWorkflow(run.workflowId).catch(() => null);
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
  if (decision.action === 'skip') return;

  if (decision.action === 'error') {
    // Restore first so the errored run actually reaches the UI (a run that was
    // never restored has nothing to mark errored, and the user would just see
    // it silently gone again).
    restoreWorkflowRun(run);
    console.warn(`[startup] workflow run ${label} cannot be resumed: ${decision.reason}`);
    failWorkflowRun(run.id, `interrupted by a backend restart — ${run.definitionError ?? decision.reason}`);
    return;
  }

  restoreWorkflowRun(run);
  if (serverId) adoptWorkflowStepSession(run.id, run.currentStepIndex, serverId);

  if (decision.action === 'complete') {
    await completeWorkflowStep(run.id, run.currentStepIndex, backendOrigin);
    return;
  }

  if (decision.action === 'redispatch') {
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
      const checkpoint = JSON.stringify([run.currentStepIndex, step?.id, tasks
        .filter((t) => ['open', 'in_progress', 'ready_to_merge'].includes(t.status))
        .map((t) => [t.id, t.status, !!t.runQueued]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
      const budget = await claimRecoveryAttempt(run.projectPath, `workflow:${run.id}`, checkpoint);
      if (!stillNeedsRedispatch()) return;
      if (budget.paused) {
        failWorkflowRun(run.id, budget.paused);
        return;
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
    console.warn(`[startup] workflow run ${label} interrupted — ${decision.reason}; re-running it.`);
    await redispatchCurrentWorkflowStep(run.id, backendOrigin).catch((err) =>
      console.error(`[startup] workflow run ${run.id}: redispatch failed:`, err),
    );
    return;
  }

  // readopt: the agent is still working. Re-attach its pty so the advance can
  // reclaim it, and put its presence node back on the graph.
  console.log(`[startup] workflow run ${label} re-adopted — ${decision.reason}.`);
  if (serverId) adoptWorkflowStepSession(run.id, run.currentStepIndex, serverId);
  if (wf && step && effectiveStepHarness(wf, run, run.currentStepIndex) === 'claude') {
    registerAgentSession({
      agentId: workflowStepAgentId(run.id, run.currentStepIndex),
      projectPath: run.projectPath,
      label: `workflow step ${run.currentStepIndex + 1}`,
    });
  }
}
