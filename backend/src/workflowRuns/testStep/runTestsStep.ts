// The workflow "Run tests" step ('test' kind) — orchestration.
//
// A Run tests step is an AGENT step with a fixed brief and a different failure
// policy (D4: it never stops the workflow). It reuses the ordinary agent-step
// machinery unchanged — `spawnWorkflowStep` (step dir under
// `<project>/.lattice/workflow-steps/<run>/step-N/`, the Claude Stop hook / Pi
// extension / Codex hooks.json, the spawn queue), the `/complete` route and its
// Claude quiescence gate — and wraps it with:
//
//   - a detached pre-spawn worker (`dispatchRunTestsStep`, fire-and-forget like
//     `executeControlStep`): the skip rule (HEAD unchanged since the last Run
//     tests, or a detached HEAD → note + advance, D16), the project run lock,
//     the USER_WIP.txt capture, the recently-merged-tasks list, then the spawn;
//   - the project run lock, label `workflow-test:<runId>`, acquired
//     NON-LENDABLE and held for the whole step. `scripts/dev.mjs` defers
//     restarts for `workflow-*` labels without the 15-minute force; a manual
//     Merge / Merge All gets a 409 naming this step; a resolver finalize or a
//     post-merge hook fired outside a merge run waits for the release
//     (`withProjectMutation` / `waitForExclusiveProjectHold`);
//   - a timeout (`timeoutMinutes`, default 60) measured from the moment the pty
//     actually spawned — time queued behind the spawn queue / resource
//     governor doesn't count. On timeout: kill the session, list what it left
//     uncommitted (git status now minus USER_WIP.txt — never reverted), advance;
//   - "note + advance" for every failure: spawn failure, the terminal lost over
//     a restart, a completion checkpoint that keeps failing, the timeout;
//   - `finalizeRunTestsStep`, called by the advance (`completeWorkflowStep`)
//     before the next step dispatches, on EVERY path: stores the step summary
//     (notes + TEST_SUMMARY.md + the commits post-check) on the run, updates
//     run-tests.json after a normal finish, and releases the lock.
//
// `completeStep` is passed in (as `executeControlStep` does) to avoid importing
// the facade that imports this module.

import fs from 'node:fs/promises';
import {
  acquireProjectRunLock,
  RUN_TESTS_LOCK_LABEL_PREFIX,
  type ProjectRunLockHandle,
} from '../../projectRunLock.js';
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
  notify,
  subscribe,
  type WorkflowRun,
  type WorkflowRunEvent,
} from '../state.js';
import { workflowStepDir } from '../scratchDirectory.js';
import { effectiveStepHarness } from '../stepMarkdown.js';
import { killWorkflowStepSession, workflowStepAgentId } from '../sessionSpawner.js';
import { spawnWorkflowStep } from '../stepSpawner.js';
import {
  isProjectHeadDetached,
  readCommitsSince,
  readProjectHead,
  readProjectStatusPaths,
} from './checkoutGit.js';
import { readRunTestsState, writeRunTestsState, type RunTestsState } from './runTestsState.js';
import { renderRecentTasksBlock, selectRecentlyMergedTasks } from './recentTasks.js';
import { renderRunTestsBrief } from './brief.js';
import { readUserWipFile, wipCovers, writeUserWipFile } from './userWip.js';
import { composeStepSummary, readTestSummaryFile, renderPostCheck } from './summary.js';

export type CompleteStepCallback = (
  runId: string,
  stepIndex: number,
  backendOrigin: string,
) => Promise<void>;

export function runTestsLockLabel(runId: string): string {
  return `${RUN_TESTS_LOCK_LABEL_PREFIX}${runId}`;
}

// How the step ended, as far as the summary / run-tests.json care:
//   agent    — the agent's own completion (the default when nothing else set it)
//   skipped  — never needed to run (HEAD unchanged, detached HEAD, lock busy)
//   not-run  — could not start (setup threw, the spawn failed)
//   timeout  — the session was killed after `timeoutMinutes`
//   lost     — the terminal did not survive a backend restart
// Only `agent` records run-tests.json: a run that didn't finish verified nothing,
// so the next Run tests must not skip on its account.
export type RunTestsOutcome = 'agent' | 'skipped' | 'not-run' | 'timeout' | 'lost';

type ActiveRunTestsStep = {
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

// One Run tests step in flight per run (a run has one current step).
const activeSteps = new Map<string, ActiveRunTestsStep>();

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
  minuteMs: 60_000,
  lockRetryMs: 5_000,
  lockWaitMs: 10 * 60_000,
  advanceRetryMs: 30_000,
};

let deps: RunTestsDeps = productionDeps;

// Test seam: swap the IO for fakes; returns a restore function.
export function setRunTestsDepsForTest(overrides: Partial<RunTestsDeps>): () => void {
  const previous = deps;
  deps = { ...productionDeps, ...overrides };
  return () => { deps = previous; };
}

function isCurrent(run: WorkflowRun, stepIndex: number): boolean {
  return run.status === 'running' && run.currentStepIndex === stepIndex;
}

function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

function stepTimeoutMinutes(wf: Workflow | undefined, stepIndex: number): number {
  return normalizeTestTimeoutMinutes(wf?.steps[stepIndex]?.timeoutMinutes) ?? RUN_TESTS_DEFAULT_TIMEOUT_MINUTES;
}

function progress(run: WorkflowRun, stepIndex: number, message: string): void {
  notify({
    type: 'step-control-progress',
    runId: run.id,
    projectPath: run.projectPath,
    stepIndex,
    kind: 'test',
    current: 0,
    total: 0,
    message,
  });
}

function beginEntry(
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

function entryFor(runId: string, stepIndex: number): ActiveRunTestsStep | undefined {
  const entry = activeSteps.get(runId);
  return entry && entry.stepIndex === stepIndex ? entry : undefined;
}

// Stop the timer + subscription and release the lock. Idempotent.
async function teardownEntry(entry: ActiveRunTestsStep): Promise<void> {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.unsubscribe?.();
  entry.unsubscribe = undefined;
  const lock = entry.lock;
  entry.lock = null;
  if (activeSteps.get(entry.run.id) === entry) activeSteps.delete(entry.run.id);
  if (lock) {
    await lock.release().catch((err) => {
      console.warn(`[workflow-run] ${entry.run.id} Run tests step ${entry.stepIndex}: releasing the project run lock failed:`, err);
    });
  }
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

// Take the project run lock (non-lendable), waiting while something else holds
// it — a manual merge that is finishing, say. Gives up after `lockWaitMs` with
// the reason, so the caller can note + skip instead of hanging.
async function acquireWithWait(entry: ActiveRunTestsStep): Promise<ProjectRunLockHandle | { gaveUp: string } | null> {
  const { run, stepIndex } = entry;
  const started = Date.now();
  let announced = false;
  for (;;) {
    if (!isCurrent(run, stepIndex)) return null;
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

function armTimeout(entry: ActiveRunTestsStep, spawnedAt: number): void {
  if (entry.timer) clearTimeout(entry.timer);
  const remaining = Math.max(0, entry.timeoutMs - (Date.now() - spawnedAt));
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void onTimeout(entry).catch((err) => {
      console.error(`[workflow-run] ${entry.run.id} Run tests step ${entry.stepIndex}: timeout handling failed:`, err);
    });
  }, remaining);
  entry.timer.unref?.();
}

async function onTimeout(entry: ActiveRunTestsStep): Promise<void> {
  const { run, stepIndex } = entry;
  if (entry.finalized || !isCurrent(run, stepIndex)) return;
  const minutes = Math.round(entry.timeoutMs / deps.minuteMs);
  await deps.killStepSession(run.id, stepIndex).catch(() => {});
  const stepDir = workflowStepDir(run.projectPath, run.id, stepIndex);
  const wip = (await readUserWipFile(stepDir)) ?? [];
  const now = await deps.readStatus(run.projectPath);
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
  await noteAndAdvance(entry, lines.join('\n'), 'timeout');
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

// Fire-and-forget entry point for a 'test' step (the facade's `dispatchStep`).
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
    progress(run, stepIndex, 'checking whether anything was merged since the last Run tests…');
    const head = await deps.readHead(project);
    if (!isCurrent(run, stepIndex)) return void (await teardownEntry(entry));
    if (await deps.isDetached(project)) {
      return void (await noteAndAdvance(
        entry,
        'Skipped: the project checkout is on a detached HEAD. Merges fast-forward the checked-out branch, so there is no branch to test and commit fixes on — check out a branch.',
        'skipped',
      ));
    }
    const state: RunTestsState | null = await deps.readState(project);
    if (head && state?.lastHead === head) {
      return void (await noteAndAdvance(
        entry,
        `Skipped: nothing merged since the last Run tests (HEAD ${shortSha(head)}, tested ${new Date(state.lastFinishedAt).toLocaleString()}).`,
        'skipped',
      ));
    }

    const lock = await acquireWithWait(entry);
    if (lock === null) return void (await teardownEntry(entry));
    if ('gaveUp' in lock) {
      return void (await noteAndAdvance(entry, `Skipped: the project stayed busy for ${Math.round(deps.lockWaitMs / 60_000)} minutes — ${lock.gaveUp}`, 'skipped'));
    }
    entry.lock = lock;
    if (!isCurrent(run, stepIndex)) return void (await teardownEntry(entry));

    // Start state, captured under the lock (a merge may have landed while we
    // waited for it).
    const startHead = await deps.readHead(project);
    const wip = await deps.readStatus(project);
    const stepDir = workflowStepDir(project, run.id, stepIndex);
    await fs.mkdir(stepDir, { recursive: true });
    const userWipFile = await writeUserWipFile(stepDir, wip ?? []);
    run.testStep = { stepIndex, startHead };
    await deps.checkpoint(run);
    if (!isCurrent(run, stepIndex)) return void (await teardownEntry(entry));

    const since = state?.lastFinishedAt ?? run.startedAt;
    const tasks = await deps.listTasks(project).catch(() => []);
    const recentTasksBlock = renderRecentTasksBlock(
      selectRecentlyMergedTasks(tasks, since),
      state ? `since the last Run tests finished (${new Date(since).toLocaleString()})` : 'since this workflow run started',
    );
    const harness = effectiveStepHarness(wf, run, stepIndex);
    const template = await deps.resolveTemplate(project, 'run-tests');
    const brief = renderRunTestsBrief(
      {
        harness,
        projectPath: project,
        stepDir,
        stepIndex,
        totalSteps: wf.steps.length,
        completeUrl: `${backendOrigin}/api/workflow-runs/${run.id}/steps/${stepIndex}/complete`,
        timeoutMinutes: Math.round(entry.timeoutMs / deps.minuteMs),
        userWipFile,
        userWipCount: wip ? wip.length : null,
        recentTasksBlock,
      },
      template,
    );

    progress(run, stepIndex, 'starting the test agent (it may wait for a free agent slot)…');
    // The timeout runs from the moment the pty exists, not from now: the spawn
    // may sit in the spawn queue behind the resource governor for a while.
    entry.unsubscribe = deps.subscribeRuns((ev: WorkflowRunEvent) => {
      if (ev.type !== 'step-spawned' || ev.runId !== run.id || ev.stepIndex !== stepIndex) return;
      entry.unsubscribe?.();
      entry.unsubscribe = undefined;
      if (entry.finalized) return;
      const spawnedAt = Date.now();
      if (run.testStep?.stepIndex === stepIndex) {
        run.testStep.spawnedAt = spawnedAt;
        void deps.checkpoint(run).catch(() => {});
      }
      armTimeout(entry, spawnedAt);
    });

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
  armTimeout(entry, checkpoint?.spawnedAt ?? Date.now());
}

// Called by the advance (`completeWorkflowStep`) for a 'test' step after its
// session is torn down and before the next step dispatches — on every path.
// Stores the summary, records run-tests.json after a normal finish, releases
// the lock. Never throws.
export async function finalizeRunTestsStep(run: WorkflowRun, stepIndex: number): Promise<void> {
  const entry = entryFor(run.id, stepIndex);
  if (entry) {
    entry.finalized = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
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
  const entry = activeSteps.get(runId);
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
  return activeSteps.has(runId);
}
