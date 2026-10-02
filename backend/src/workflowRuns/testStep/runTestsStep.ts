// The workflow "Run tests" step ('test' kind) — orchestration and public
// surface. Design, invariants and the module map: ./CLAUDE.md.

import { acquireProjectRunLock } from '../../projectRunLock.js';
import { resolveInstructionTemplate } from '../../instructionTemplates.js';
import { listTasks } from '../../tasks.js';
import { unregisterAgentSession } from '../../agentSessions.js';
import { forgetAgentQuiescence } from '../../agentQuiescence.js';
import {
  RUN_TESTS_DEFAULT_TIMEOUT_MINUTES,
  normalizeTestTimeoutMinutes,
  type Workflow,
} from '../../workflows.js';
import {
  checkpointWorkflowRun,
  subscribe,
  type WorkflowRun,
} from '../state.js';
import { workflowStepDir } from '../scratchDirectory.js';
import { killWorkflowStepSession, workflowStepAgentId } from '../sessionSpawner.js';
import { spawnWorkflowStep } from '../stepSpawner.js';
import {
  isProjectHeadDetached,
  readCommitsSince,
  readProjectHead,
  readProjectStatusPaths,
} from './checkoutGit.js';
import { readRunTestsState, writeRunTestsState } from './runTestsState.js';
import { readUserWipFile } from './userWip.js';
import { composeStepSummary, readTestSummaryFile, renderPostCheck } from './summary.js';
import {
  beginEntry,
  entryFor,
  entryForRun,
  hasEntry,
  isCurrent,
  progress,
  stopEntryWatchers,
  teardownEntry,
  type ActiveRunTestsStep,
  type CompleteStepCallback,
  type RunTestsOutcome,
} from './runTestsLifecycle.js';
import {
  acquireWithWait,
  armTimeout,
  armTimeoutOnSpawn,
  lockGaveUpNote,
  MINUTE_MS,
  runTestsLockLabel,
  type LockWaitContext,
} from './lockWait.js';
import { buildRunTestsBrief, captureStartState, preflightSkipNote } from './startState.js';

export type { CompleteStepCallback, RunTestsOutcome } from './runTestsLifecycle.js';
export { runTestsLockLabel };

export type RunTestsDeps = {
  acquireLock: typeof acquireProjectRunLock;
  readHead: typeof readProjectHead;
  isDetached: typeof isProjectHeadDetached;
  readStatus: typeof readProjectStatusPaths;
  readCommitsSince: typeof readCommitsSince;
  readState: typeof readRunTestsState;
  writeState: typeof writeRunTestsState;
  listTasks: typeof listTasks;
  resolveTemplate: typeof resolveInstructionTemplate;
  spawnStep: typeof spawnWorkflowStep;
  killStepSession: (runId: string, stepIndex: number) => Promise<void>;
  subscribeRuns: typeof subscribe;
  checkpoint: typeof checkpointWorkflowRun;
  // Milliseconds per `timeoutMinutes` unit (tests shrink it).
  minuteMs: number;
  // Waiting for a busy project run lock: retry cadence and give-up bound.
  lockRetryMs: number;
  lockWaitMs: number;
  // Retry cadence when the advance itself fails (the run checkpoint write).
  advanceRetryMs: number;
};

const productionDeps: RunTestsDeps = {
  acquireLock: acquireProjectRunLock,
  readHead: readProjectHead,
  isDetached: isProjectHeadDetached,
  readStatus: readProjectStatusPaths,
  readCommitsSince,
  readState: readRunTestsState,
  writeState: writeRunTestsState,
  listTasks,
  resolveTemplate: resolveInstructionTemplate,
  spawnStep: spawnWorkflowStep,
  killStepSession: (runId, stepIndex) => killWorkflowStepSession(runId, stepIndex),
  subscribeRuns: subscribe,
  checkpoint: checkpointWorkflowRun,
  minuteMs: MINUTE_MS,
  lockRetryMs: 5_000,
  lockWaitMs: 10 * MINUTE_MS,
  advanceRetryMs: 30_000,
};

let deps: RunTestsDeps = productionDeps;

// Test seam: swap the IO for fakes; returns a restore function.
export function setRunTestsDepsForTest(overrides: Partial<RunTestsDeps>): () => void {
  const previous = deps;
  deps = { ...productionDeps, ...overrides };
  return () => { deps = previous; };
}

function stepTimeoutMinutes(wf: Workflow | undefined, stepIndex: number): number {
  return normalizeTestTimeoutMinutes(wf?.steps[stepIndex]?.timeoutMinutes) ?? RUN_TESTS_DEFAULT_TIMEOUT_MINUTES;
}

// Advance past the step (the note, if any, is already on the entry). The
// advance's own completion checkpoint can fail (EPERM under an AV scanner,
// ENOSPC); the workflow must still move on eventually, so keep retrying while
// the step is current.
async function advance(entry: ActiveRunTestsStep): Promise<void> {
  const { run, stepIndex } = entry;
  if (!entry.completeStep) return;
  for (;;) {
    if (!isCurrent(run, stepIndex) || entry.finalized) return;
    try {
      await entry.completeStep(run.id, stepIndex, entry.backendOrigin);
      return;
    } catch (err) {
      console.error(`[workflow-run] ${run.id} Run tests step ${stepIndex}: advancing failed (retrying):`, err);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, deps.advanceRetryMs);
        t.unref?.();
      });
    }
  }
}

async function noteAndAdvance(entry: ActiveRunTestsStep, note: string, outcome: RunTestsOutcome): Promise<void> {
  if (entry.finalized) return;
  if (!isCurrent(entry.run, entry.stepIndex)) {
    // The run moved on (cancelled / errored) without us: just let go.
    await teardownEntry(entry);
    return;
  }
  entry.notes.push(note);
  entry.outcome = outcome;
  console.log(`[workflow-run] ${entry.run.id} Run tests step ${entry.stepIndex}: ${note.split('\n')[0]}`);
  await advance(entry);
}

// lockWait.ts reads `deps` through this on every use, so a swap reaches its
// lock wait and timers.
const lockWait: LockWaitContext = { deps: () => deps, noteAndAdvance };

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

// Fire-and-forget entry point for a 'test' step (dispatch.ts's `dispatchStep`).
// The skip check, lock wait and spawn run detached from the caller — which is
// the PREVIOUS step's completion, so a skip must not advance recursively
// inside it.
export function dispatchRunTestsStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  completeStep: CompleteStepCallback,
): void {
  runRunTestsWorker(wf, run, stepIndex, backendOrigin, completeStep).catch((err) => {
    console.error(`[workflow-run] ${run.id} Run tests step ${stepIndex} worker rejected:`, err);
  });
}

export async function runRunTestsWorker(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  completeStep: CompleteStepCallback,
): Promise<void> {
  await Promise.resolve(); // never run synchronously inside the dispatcher
  if (!isCurrent(run, stepIndex)) return;
  const project = run.projectPath;
  const entry = beginEntry(run, stepIndex, backendOrigin, completeStep, stepTimeoutMinutes(wf, stepIndex) * deps.minuteMs);
  try {
    // 1. Preflight: the skip rule (D16).
    progress(run, stepIndex, 'checking whether anything was merged since the last Run tests…');
    const head = await deps.readHead(project);
    if (!isCurrent(run, stepIndex)) return void (await teardownEntry(entry));
    const preflight = await preflightSkipNote(deps, project, head);
    if ('skip' in preflight) return void (await noteAndAdvance(entry, preflight.skip, 'skipped'));
    const { state } = preflight;

    // 2. The project run lock (non-lendable), waiting while something holds it.
    const lock = await acquireWithWait(lockWait, entry);
    if (lock === null) return void (await teardownEntry(entry));
    if ('gaveUp' in lock) return void (await noteAndAdvance(entry, lockGaveUpNote(lockWait, lock.gaveUp), 'skipped'));
    entry.lock = lock;
    if (!isCurrent(run, stepIndex)) return void (await teardownEntry(entry));

    // 3. Start state under the lock, then the brief.
    const start = await captureStartState(deps, run, stepIndex);
    if (!isCurrent(run, stepIndex)) return void (await teardownEntry(entry));
    const brief = await buildRunTestsBrief(deps, wf, entry, state, start);

    // 4. Arm the timeout on the pty's spawn, then spawn.
    progress(run, stepIndex, 'starting the test agent (it may wait for a free agent slot)…');
    armTimeoutOnSpawn(lockWait, entry);
    await deps.spawnStep(wf, run, stepIndex, backendOrigin, {
      runTests: {
        brief,
        addDir: project,
        onSpawnError: (message) => {
          void noteAndAdvance(entry, `Run tests could not start its agent: ${message}`, 'not-run');
        },
      },
    });
  } catch (err) {
    if (!isCurrent(run, stepIndex)) {
      await teardownEntry(entry);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await noteAndAdvance(entry, `Run tests could not start: ${message}`, 'not-run');
  }
}

// Record a note for the step (and, when given, how it ended) for a path that
// advances it from outside the worker — boot recovery's "terminal gone", the
// stop-hook gate's failed checkpoints. Creates an entry if the worker isn't
// tracking one (it isn't, after a restart).
export function noteRunTestsStep(run: WorkflowRun, stepIndex: number, note: string, outcome?: RunTestsOutcome): void {
  const entry = entryFor(run.id, stepIndex) ?? beginEntry(run, stepIndex, '', null, 0);
  entry.notes.push(note);
  if (outcome) entry.outcome = outcome;
}

// Re-attach a Run tests step whose agent survived a backend restart: take the
// project run lock again (the previous backend's is stale → stealable) and
// re-arm the timeout from the recorded spawn time. Never throws; a lock that
// can't be re-taken is noted, not fatal.
export async function resumeRunTestsStep(
  wf: Workflow | undefined,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  completeStep: CompleteStepCallback,
): Promise<void> {
  const entry = beginEntry(run, stepIndex, backendOrigin, completeStep, stepTimeoutMinutes(wf, stepIndex) * deps.minuteMs);
  try {
    entry.lock = await deps.acquireLock(run.projectPath, runTestsLockLabel(run.id), { lendable: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    entry.notes.push(`After a backend restart Lattice could not re-take the project run lock (${message}); merges were not held off for the rest of this step.`);
    console.warn(`[startup] workflow run ${run.id} Run tests step ${stepIndex}: could not re-acquire the project run lock: ${message}`);
  }
  if (!isCurrent(run, stepIndex)) {
    await teardownEntry(entry);
    return;
  }
  const checkpoint = run.testStep?.stepIndex === stepIndex ? run.testStep : undefined;
  armTimeout(lockWait, entry, checkpoint?.spawnedAt ?? Date.now());
}

// Called by the advance (`completeWorkflowStep`) for a 'test' step after its
// session is torn down and before the next step dispatches — on every path.
// Stores the summary, records run-tests.json after a normal finish, releases
// the lock. Never throws.
export async function finalizeRunTestsStep(run: WorkflowRun, stepIndex: number): Promise<void> {
  const entry = entryFor(run.id, stepIndex);
  if (entry) {
    entry.finalized = true;
    stopEntryWatchers(entry);
  }
  const agentId = workflowStepAgentId(run.id, stepIndex);
  unregisterAgentSession(agentId);
  forgetAgentQuiescence(agentId);
  try {
    const outcome = entry?.outcome ?? 'agent';
    const checkpoint = run.testStep?.stepIndex === stepIndex ? run.testStep : undefined;
    const ran = checkpoint !== undefined && outcome !== 'skipped' && outcome !== 'not-run';
    const stepDir = workflowStepDir(run.projectPath, run.id, stepIndex);
    const report = ran ? await readTestSummaryFile(stepDir) : null;
    let postCheck = '';
    if (ran && checkpoint?.startHead) {
      const wip = await readUserWipFile(stepDir);
      postCheck = renderPostCheck(await deps.readCommitsSince(run.projectPath, checkpoint.startHead), wip);
    }
    const summary = composeStepSummary({ notes: entry?.notes ?? [], report, reportExpected: ran, postCheck });
    if (summary) run.stepSummaries = { ...(run.stepSummaries ?? {}), [stepIndex]: summary };
    if (outcome === 'agent' && checkpoint) {
      // HEAD at the FINISH, so this step's own fix commits don't read as
      // "something was merged" to the next Run tests.
      const head = await deps.readHead(run.projectPath);
      if (head) {
        await deps.writeState(run.projectPath, { lastHead: head, lastFinishedAt: Date.now() }).catch((err) => {
          console.warn(`[workflow-run] ${run.id} Run tests step ${stepIndex}: could not write run-tests.json:`, err);
        });
      }
    }
  } catch (err) {
    console.error(`[workflow-run] ${run.id} Run tests step ${stepIndex}: finalize failed (continuing):`, err);
  } finally {
    if (run.testStep?.stepIndex === stepIndex) delete run.testStep;
    if (entry) await teardownEntry(entry);
  }
}

// The run was cancelled or errored: stop the timer, drop the subscription and
// release the lock. Idempotent; a no-op when no Run tests step is tracked.
export async function abortRunTestsStep(runId: string): Promise<void> {
  const entry = entryForRun(runId);
  if (!entry) return;
  entry.finalized = true;
  await teardownEntry(entry);
}

// For the stop-hook gate: is this run's CURRENT step a Run tests step?
export function isRunTestsStep(run: Pick<WorkflowRun, 'definition'>, stepIndex: number): boolean {
  return run.definition?.steps[stepIndex]?.kind === 'test';
}

// Test/debug: is a Run tests step tracked (lock/timer) for this run?
export function hasActiveRunTestsStep(runId: string): boolean {
  return hasEntry(runId);
}
