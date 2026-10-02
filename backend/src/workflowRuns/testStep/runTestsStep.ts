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
  subscribe,
  type WorkflowRun,
  type WorkflowRunEvent,
} from '../state.js';
import { workflowStepDir } from '../scratchDirectory.js';
import { effectiveStepHarness } from '../stepMarkdown.js';
import { killWorkflowStepSession, workflowStepAgentId } from '../sessionSpawner.js';
import { spawnWorkflowStep } from '../stepSpawner.js';
import { emitControlProgress } from '../controlSteps/shared.js';
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
import {
  beginEntry,
  entryFor,
  entryForRun,
  hasEntry,
  stopEntryWatchers,
  teardownEntry,
  type ActiveRunTestsStep,
  type CompleteStepCallback,
  type RunTestsOutcome,
} from './runTestsLifecycle.js';

export type { CompleteStepCallback, RunTestsOutcome } from './runTestsLifecycle.js';

export function runTestsLockLabel(runId: string): string {
  return `${RUN_TESTS_LOCK_LABEL_PREFIX}${runId}`;
}

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

const MINUTE_MS = 60_000;

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
  emitControlProgress(run, stepIndex, 'test', 0, 0, message);
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
// Worker phases — `runRunTestsWorker` runs them in order and re-checks
// `isCurrent` between them.
// ---------------------------------------------------------------------------

// Phase 1: the skip rule — a detached HEAD, or HEAD unchanged since the last
// Run tests. `head` is read by the worker (it re-checks the run after). Returns
// the skip note, or the run-tests.json state the brief needs.
async function preflightSkipNote(
  project: string,
  head: string | null,
): Promise<{ skip: string } | { state: RunTestsState | null }> {
  if (await deps.isDetached(project)) {
    return {
      skip: 'Skipped: the project checkout is on a detached HEAD. Merges fast-forward the checked-out branch, so there is no branch to test and commit fixes on — check out a branch.',
    };
  }
  const state: RunTestsState | null = await deps.readState(project);
  if (head && state?.lastHead === head) {
    return {
      skip: `Skipped: nothing merged since the last Run tests (HEAD ${shortSha(head)}, tested ${new Date(state.lastFinishedAt).toLocaleString()}).`,
    };
  }
  return { state };
}

// Phase 2's give-up note. Real minutes — not `deps.minuteMs`, the timeout unit
// tests shrink.
function lockGaveUpNote(reason: string): string {
  return `Skipped: the project stayed busy for ${Math.round(deps.lockWaitMs / MINUTE_MS)} minutes — ${reason}`;
}

type RunTestsStartState = {
  stepDir: string;
  wip: string[] | null;
  userWipFile: string;
};

// Phase 3a: start state, captured under the lock (a merge may have landed
// while we waited for it) — USER_WIP.txt and the `run.testStep` checkpoint.
async function captureStartState(run: WorkflowRun, stepIndex: number): Promise<RunTestsStartState> {
  const project = run.projectPath;
  const startHead = await deps.readHead(project);
  const wip = await deps.readStatus(project);
  const stepDir = workflowStepDir(project, run.id, stepIndex);
  await fs.mkdir(stepDir, { recursive: true });
  const userWipFile = await writeUserWipFile(stepDir, wip ?? []);
  run.testStep = { stepIndex, startHead };
  await deps.checkpoint(run);
  return { stepDir, wip, userWipFile };
}

// Phase 3b: RUN_TESTS.md — the recently-merged-tasks block and the project's
// `run-tests` template.
async function buildRunTestsBrief(
  wf: Workflow,
  entry: ActiveRunTestsStep,
  state: RunTestsState | null,
  start: RunTestsStartState,
): Promise<string> {
  const { run, stepIndex, backendOrigin } = entry;
  const project = run.projectPath;
  const since = state?.lastFinishedAt ?? run.startedAt;
  const tasks = await deps.listTasks(project).catch(() => []);
  const recentTasksBlock = renderRecentTasksBlock(
    selectRecentlyMergedTasks(tasks, since),
    state ? `since the last Run tests finished (${new Date(since).toLocaleString()})` : 'since this workflow run started',
  );
  const harness = effectiveStepHarness(wf, run, stepIndex);
  const template = await deps.resolveTemplate(project, 'run-tests');
  return renderRunTestsBrief(
    {
      harness,
      projectPath: project,
      stepDir: start.stepDir,
      stepIndex,
      totalSteps: wf.steps.length,
      completeUrl: `${backendOrigin}/api/workflow-runs/${run.id}/steps/${stepIndex}/complete`,
      timeoutMinutes: Math.round(entry.timeoutMs / deps.minuteMs),
      userWipFile: start.userWipFile,
      userWipCount: start.wip ? start.wip.length : null,
      recentTasksBlock,
    },
    template,
  );
}

// Phase 4 (before the spawn): the timeout runs from the moment the pty exists,
// not from now — the spawn may sit in the spawn queue behind the resource
// governor for a while. The step's `step-spawned` records `spawnedAt` (so a
// re-adopting backend re-arms the remainder) and arms the timer.
function armTimeoutOnSpawn(entry: ActiveRunTestsStep): void {
  const { run, stepIndex } = entry;
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
}

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
    const preflight = await preflightSkipNote(project, head);
    if ('skip' in preflight) return void (await noteAndAdvance(entry, preflight.skip, 'skipped'));
    const { state } = preflight;

    // 2. The project run lock (non-lendable), waiting while something holds it.
    const lock = await acquireWithWait(entry);
    if (lock === null) return void (await teardownEntry(entry));
    if ('gaveUp' in lock) return void (await noteAndAdvance(entry, lockGaveUpNote(lock.gaveUp), 'skipped'));
    entry.lock = lock;
    if (!isCurrent(run, stepIndex)) return void (await teardownEntry(entry));

    // 3. Start state under the lock, then the brief.
    const start = await captureStartState(run, stepIndex);
    if (!isCurrent(run, stepIndex)) return void (await teardownEntry(entry));
    const brief = await buildRunTestsBrief(wf, entry, state, start);

    // 4. Arm the timeout on the pty's spawn, then spawn.
    progress(run, stepIndex, 'starting the test agent (it may wait for a free agent slot)…');
    armTimeoutOnSpawn(entry);
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
