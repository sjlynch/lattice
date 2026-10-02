// Step-completion / advance engine — re-exported by the facade
// (../workflowRuns.ts). Settles a completed member, joins its group, and
// dispatches the next group through ./dispatch.ts, handing it
// completeWorkflowStep as the completion callback (dispatch.ts can't import
// it back without a circular import).

import { getWorkflow, type Workflow } from '../workflows.js';
import {
  notify,
  runs,
  snapshot,
  type WorkflowRun,
  checkpointWorkflowRun,
} from './state.js';
import { activeStepIndices, isWorkflowStepActive, nextStepGroup, openStepGroup,
  setStepPhase, stepPhase } from './execution.js';
import { runExclusive } from '../serializeWrites.js';
import {
  killWorkflowStepSession,
  releaseWorkflowStepSession,
  workflowStepAgentId,
} from './sessionSpawner.js';
import { isKeepWorkflowStepTerminalsEnabled } from '../userSettings.js';
import { forgetAgentQuiescence } from '../agentQuiescence.js';
import { unregisterAgentSession } from '../agentSessions.js';
import { trackRestartTransition } from '../restartDrain/gate.js';
import { finalizeRunTestsStep } from './testStep/runTestsStep.js';
import { dispatchGroup, dispatchStep } from './dispatch.js';
import { failWorkflowRun } from './failRun.js';

// The advance a step-completion callback performs: drop the step's graph node
// + quiescence state, then advance the run (which kills the finishing step's
// pty before dispatching the next one). Shared by the `/complete` route and by
// boot recovery re-arming a Stop the previous process had received but not yet
// acted on (WorkflowRun.stopReceived).
export function workflowStepCompletionAdvance(
  runId: string,
  stepIndex: number,
  backendOrigin: string,
): () => Promise<void> {
  const agentId = workflowStepAgentId(runId, stepIndex);
  return async () => {
    await completeWorkflowStep(runId, stepIndex, backendOrigin);
    unregisterAgentSession(agentId);
    forgetAgentQuiescence(agentId);
  };
}

// In-flight step advances keyed `${runId}:${stepIndex}`, so a re-fired Stop
// hook joins the advance already running instead of starting a second one.
const completions = new Map<string, Promise<void>>();

// Test seams for advanceCompletedStep; each defaults to the real implementation.
type AdvanceDeps = {
  killStepSession?: typeof killWorkflowStepSession;
  releaseStepSession?: typeof releaseWorkflowStepSession;
  dispatchStep?: typeof dispatchStep;
  finalizeTestStep?: typeof finalizeRunTestsStep;
  // Boot can finish the join checkpoint after every member was reclaimed.
  resumeCompleted?: boolean;
};

// Called by the Stop-hook callback. Idempotent: stale hooks (same stepIndex
// re-firing) are silently ignored via the active-member check.
export async function completeWorkflowStep(
  runId: string,
  stepIndex: number,
  backendOrigin: string,
  deps: AdvanceDeps = {},
): Promise<void> {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return;
  if (run.definitionError) throw new Error(run.definitionError);
  if (!isWorkflowStepActive(run, stepIndex) && !(deps.resumeCompleted &&
    activeStepIndices(run).includes(stepIndex) && run.stepStates?.[stepIndex]?.phase === 'completed')) return;

  const key = `${runId}:${stepIndex}`;
  if (completions.has(key)) return completions.get(key);
  // Tracked for the restart drain: its settle waits for an in-flight advance
  // (checkpoint → teardown → next dispatch) before telling the dev runner the
  // backend may be killed.
  const completing = trackRestartTransition(
    `workflow ${runId} advance from step ${stepIndex}`,
    advanceCompletedStep(run, stepIndex, backendOrigin, deps),
  );
  completions.set(key, completing);
  try { await completing; } finally { if (completions.get(key) === completing) completions.delete(key); }
}

async function advanceCompletedStep(run: WorkflowRun, stepIndex: number, backendOrigin: string,
  deps: AdvanceDeps): Promise<void> {
  const previousPhase = stepPhase(run, stepIndex);
  setStepPhase(run, stepIndex, 'completing');
  try {
    await checkpointWorkflowRun(run);
  } catch (err) {
    if (isWorkflowStepActive(run, stepIndex)) setStepPhase(run, stepIndex, previousPhase ?? 'running');
    throw err;
  }
  try {
    const keepOpen = await isKeepWorkflowStepTerminalsEnabled(run.projectPath).catch(() => false);
    await (keepOpen
      ? (deps.releaseStepSession ?? releaseWorkflowStepSession)
      : (deps.killStepSession ?? killWorkflowStepSession))(run.id, stepIndex);
    if (!isWorkflowStepActive(run, stepIndex)) return;
    const wf = run.definition ?? await getWorkflow(run.workflowId);
    if (!isWorkflowStepActive(run, stepIndex)) return;
    if (!wf) { failWorkflowRun(run.id, 'workflow definition not found'); return; }
    if (wf.steps[stepIndex]?.kind === 'test') {
      await (deps.finalizeTestStep ?? finalizeRunTestsStep)(run, stepIndex);
      if (!isWorkflowStepActive(run, stepIndex)) return;
    }
    // Serialize the durable member settlement and group join. Two last callbacks
    // cannot both dispatch a successor, nor observe an uncheckpointed completion.
    let dispatchNext = false;
    await runExclusive(`workflow-group:${run.id}`, async () => {
      if (!isWorkflowStepActive(run, stepIndex)) return;
      if (run.stepStates) {
        setStepPhase(run, stepIndex, 'completed');
        delete run.stepStates[stepIndex].stopReceived;
        delete run.stepStates[stepIndex].sessionId;
      }
      if (run.stopReceived?.stepIndex === stepIndex) delete run.stopReceived;
      await checkpointWorkflowRun(run);
      if (run.status !== 'running') return;
      if (run.stepStates && activeStepIndices(run).some((i) => run.stepStates![i].phase !== 'completed')) {
        notify({ type: 'progress', run: snapshot(run) });
        return;
      }
      const next = nextStepGroup(wf.steps, run.groupEndIndex ?? stepIndex + 1);
      if (!next) { await completeRun(run, wf); return; }
      openStepGroup(run, wf.steps, next);
      await checkpointWorkflowRun(run);
      notify({ type: 'progress', run: snapshot(run) });
      dispatchNext = true;
    });
    // Dispatch outside the join lock: an unrelated member's pre-run can take
    // minutes, and must not hold callbacks for the new group's other members.
    if (dispatchNext && run.status === 'running') {
      await dispatchGroup(wf, run, backendOrigin, completeWorkflowStep, deps.dispatchStep ?? dispatchStep);
    }
  } catch (err) {
    if (run.status !== 'running') return;
    failWorkflowRun(run.id, (err as Error).message ?? 'advance failed');
  }
}

// Finish a run whose last runnable step just completed.
async function completeRun(run: WorkflowRun, wf: Workflow): Promise<void> {
  // Park the index past the last step so every editor row reads as done.
  // `max` keeps a claim that already overshot (workflow shortened mid-run).
  run.currentStepIndex = Math.max(run.currentStepIndex, wf.steps.length);
  run.activeStepIndices = [];
  run.status = 'completed';
  run.finishedAt = Date.now();
  console.log(`[workflow-run] ${run.id} completed all ${wf.steps.length} step(s)`);
  notify({ type: 'completed', run: snapshot(run) });
  await checkpointWorkflowRun(run);
}
