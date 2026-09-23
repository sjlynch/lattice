import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { completeWorkflowStep, startWorkflowRun } from '../workflowRuns.js';
import { notify, runs, type WorkflowRun } from '../workflowRuns/state.js';
import { createWorkflow, normalizeSteps, type WorkflowStep } from '../workflows.js';
import { classifyWorkflowRunResume } from '../workflowRuns/resumeDecision.js';
import {
  hasActiveRunTestsStep,
  runTestsLockLabel,
  setRunTestsDepsForTest,
  type RunTestsDeps,
} from '../workflowRuns/testStep/runTestsStep.js';
import { parsePorcelainZ, parseUserWipFile, renderUserWipFile, wipCovers } from '../workflowRuns/testStep/userWip.js';
import { parseLogNameOnlyZ, readProjectStatusPaths } from '../workflowRuns/testStep/checkoutGit.js';
import { renderRunTestsBrief } from '../workflowRuns/testStep/brief.js';
import { composeStepSummary, renderPostCheck } from '../workflowRuns/testStep/summary.js';
import { renderRecentTasksBlock, selectRecentlyMergedTasks } from '../workflowRuns/testStep/recentTasks.js';
import { parseRunTestsState } from '../workflowRuns/testStep/runTestsState.js';
import { buildWorkflowStepCommand } from '../workflowRuns/commandBuilder.js';
import { workflowStepDir } from '../workflowRuns/scratchDirectory.js';
import {
  acquireProjectRunLock,
  inspectProjectRunLock,
  withProjectMutation,
  ProjectRunLockedError,
} from '../projectRunLock.js';
import { isResumableInterruptedRunLock } from '../recovery/mergeRunResume.js';
import { renderPushInstructions } from '../pushRuns/instructions.js';
import {
  DEFAULT_PUSH_TEMPLATE,
  DEFAULT_WORKFLOW_PUSH_TEMPLATE,
  getInstructionTemplateDef,
} from '../instructionTemplates/defs.js';
import { deserializeWorkflowRun, serializeWorkflowRuns } from '../workflowRuns/persistence.js';
import type { Task } from '../tasks.js';

// The workflow "Run tests" step ('test' kind): an agent step with a fixed brief
// that never stops the workflow. These pin its normalization, dispatch, skip
// rule, lock (label + non-lendable), timeout, summary and brief.

const ORIGIN = 'http://127.0.0.1:5184';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function testStep(over: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id: `t${Math.random().toString(36).slice(2, 7)}`, title: 'Run tests', prompt: '', harness: 'claude', kind: 'test', ...over };
}

type Harness = {
  project: string;
  calls: { spawn: Array<Parameters<RunTestsDeps['spawnStep']>>; kill: number; writeState: Array<{ lastHead: string }> };
  restore: () => void;
  cleanup: () => Promise<void>;
};

async function setup(overrides: Partial<RunTestsDeps> = {}): Promise<Harness> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-runtests-'));
  const calls: Harness['calls'] = { spawn: [], kill: 0, writeState: [] };
  const restore = setRunTestsDepsForTest({
    readHead: async () => 'aaaaaaa1',
    isDetached: async () => false,
    readStatus: async () => [],
    readCommitsSince: async () => [],
    readState: async () => null,
    writeState: async (_p, s) => { calls.writeState.push(s); },
    listTasks: async () => [],
    spawnStep: async (...args) => { calls.spawn.push(args); return { command: 'claude', cwd: '' }; },
    killStepSession: async () => { calls.kill += 1; },
    ...overrides,
  });
  return {
    project,
    calls,
    restore,
    cleanup: async () => {
      restore();
      for (const [id, r] of [...runs.entries()]) if (r.projectPath.toLowerCase().includes('lattice-runtests-')) runs.delete(id);
      await sleep(150); // let the workflow store flush
      await fs.rm(project, { recursive: true, force: true });
    },
  };
}

async function startTestRun(project: string, steps: WorkflowStep[]): Promise<WorkflowRun> {
  const wf = await createWorkflow(project, 'Run tests wf', steps);
  const started = await startWorkflowRun(wf.id, ORIGIN);
  return runs.get(started.id)!;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test("normalizeSteps keeps kind 'test' and clamps timeoutMinutes (test steps only)", () => {
  const [plain, set, low, high, junk, agent] = normalizeSteps([
    { title: 'a', kind: 'test' },
    { title: 'b', kind: 'test', timeoutMinutes: 42.4 },
    { title: 'c', kind: 'test', timeoutMinutes: 1 },
    { title: 'd', kind: 'test', timeoutMinutes: 99999 },
    { title: 'e', kind: 'test', timeoutMinutes: 'soon' },
    { title: 'f', kind: 'agent', timeoutMinutes: 30 },
  ]);
  assert.equal(plain.kind, 'test', "'test' must not silently become 'agent'");
  assert.equal(plain.timeoutMinutes, undefined, 'absent = the 60-minute default');
  assert.equal(set.timeoutMinutes, 42);
  assert.equal(low.timeoutMinutes, 5);
  assert.equal(high.timeoutMinutes, 720);
  assert.equal(junk.timeoutMinutes, undefined);
  assert.equal(agent.timeoutMinutes, undefined, 'only Run tests steps carry a timeout');
  assert.equal('timeoutMinutes' in JSON.parse(JSON.stringify(agent)), false);
});

// ---------------------------------------------------------------------------
// Resume policy
// ---------------------------------------------------------------------------

test("resume: a live Run tests terminal is re-adopted (never re-dispatched); a gone one advances instead of erroring", () => {
  const base = { status: 'running' as const, currentStepIndex: 0, definitionStepCount: 2, stepKind: 'test' as const };
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: true, stepPhase: 'running' }).action, 'readopt');
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: null, stepPhase: 'running' }).action, 'readopt');
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: false, stepPhase: 'running' }).action, 'advance');
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: false, stepPhase: 'spawning' }).action, 'advance');
  // Never requested a terminal (skip check / lock wait) → run the worker again.
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: false, stepPhase: 'pending' }).action, 'redispatch');
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: true, stepPhase: 'completing' }).action, 'complete');
  // An ordinary agent step keeps erroring.
  assert.equal(classifyWorkflowRunResume({ ...base, stepKind: 'agent', stepSessionAlive: false, stepPhase: 'running' }).action, 'error');
});

test('the run mirror round-trips stepSummaries and the Run tests checkpoint', () => {
  const run: WorkflowRun = {
    id: 'wfrun_mirror', workflowId: 'wf', workflowName: 'wf', projectPath: os.tmpdir(), status: 'running',
    startedAt: 1, totalSteps: 2, currentStepIndex: 1,
    stepSummaries: { 0: 'all green' },
    testStep: { stepIndex: 1, startHead: 'abcdef1234', spawnedAt: 5 },
  };
  const back = deserializeWorkflowRun(JSON.parse(serializeWorkflowRuns([run])).runs[0]);
  assert.deepEqual(back?.stepSummaries, { 0: 'all green' });
  assert.deepEqual(back?.testStep, { stepIndex: 1, startHead: 'abcdef1234', spawnedAt: 5 });
  const bad = deserializeWorkflowRun({ ...run, testStep: { stepIndex: 1, startHead: '$(rm -rf /)' } });
  assert.equal(bad?.testStep?.startHead, null, 'a non-hex HEAD never reaches a git revision range');
});

// ---------------------------------------------------------------------------
// Dispatch, skip, finish
// ---------------------------------------------------------------------------

test("a 'test' step dispatches to the agent spawner with the Run tests brief, under a workflow-test lock", async () => {
  let lockDuringSpawn: string | undefined;
  const h = await setup({
    spawnStep: async (...args) => {
      h.calls.spawn.push(args);
      lockDuringSpawn = (await inspectProjectRunLock(args[1].projectPath))?.holder.label;
      return { command: 'claude', cwd: '' };
    },
  });
  try {
    const run = await startTestRun(h.project, [testStep({ timeoutMinutes: 30 })]);
    await waitFor(() => lockDuringSpawn !== undefined, 3000, 'spawn');
    const [, , stepIndex, , opts] = h.calls.spawn[0];
    assert.equal(stepIndex, 0);
    assert.ok(opts?.runTests, 'spawned as a Run tests step');
    assert.equal(opts!.runTests!.addDir, run.projectPath);
    assert.match(opts!.runTests!.brief, /# Run tests/);
    assert.match(opts!.runTests!.brief, /30 minutes/);
    assert.doesNotMatch(opts!.runTests!.brief, /\{\{\s*\w+\s*\}\}/, 'no leftover template tokens');
    assert.equal(lockDuringSpawn, runTestsLockLabel(run.id));
    const wipFile = await fs.readFile(path.join(workflowStepDir(run.projectPath, run.id, 0), 'USER_WIP.txt'), 'utf8');
    assert.match(wipFile, /0 path\(s\)/);
    assert.equal(run.status, 'running', 'waits for the agent');
  } finally {
    await h.cleanup();
  }
});

test('Run tests skips (note + advance, no spawn, no lock) when HEAD is unchanged since the last Run tests', async () => {
  const h = await setup({ readState: async () => ({ lastHead: 'aaaaaaa1', lastFinishedAt: Date.now() - 1000 }) });
  try {
    const run = await startTestRun(h.project, [testStep()]);
    await waitFor(() => run.status !== 'running', 3000, 'skip advance');
    assert.equal(run.status, 'completed');
    assert.equal(h.calls.spawn.length, 0);
    assert.match(run.stepSummaries?.[0] ?? '', /nothing merged since the last Run tests/);
    assert.equal(h.calls.writeState.length, 0, 'a skip records nothing');
    assert.equal(await inspectProjectRunLock(run.projectPath), null);
  } finally {
    await h.cleanup();
  }
});

test('Run tests skips a detached HEAD with a note', async () => {
  const h = await setup({ isDetached: async () => true });
  try {
    const run = await startTestRun(h.project, [testStep()]);
    await waitFor(() => run.status !== 'running', 3000, 'skip advance');
    assert.equal(h.calls.spawn.length, 0);
    assert.match(run.stepSummaries?.[0] ?? '', /detached HEAD/);
  } finally {
    await h.cleanup();
  }
});

test('a normal finish stores TEST_SUMMARY.md + the post-check, records run-tests.json at the FINISH head, releases the lock', async () => {
  let head = 'aaaaaaa1';
  const h = await setup({
    readHead: async () => head,
    readStatus: async () => ['user wip.ts'],
    readCommitsSince: async () => [
      { sha: 'bbbbbbb', subject: 'fix flaky test', files: ['src/a.test.ts'] },
      { sha: 'ccccccc', subject: 'oops', files: ['user wip.ts'] },
    ],
  });
  try {
    // The second step is frozen so the advance completes the run instead of
    // spawning a real agent.
    const run = await startTestRun(h.project, [testStep(), testStep({ kind: 'agent', prompt: 'next', frozen: true })]);
    await waitFor(() => h.calls.spawn.length === 1, 3000, 'spawn');
    const stepDir = workflowStepDir(run.projectPath, run.id, 0);
    await fs.writeFile(path.join(stepDir, 'TEST_SUMMARY.md'), '# Ran npm test\n\n2 failures fixed.', 'utf8');
    head = 'ddddddd9'; // the agent's own fix commits moved HEAD
    await completeWorkflowStep(run.id, 0, ORIGIN);
    const summary = run.stepSummaries?.[0] ?? '';
    assert.match(summary, /2 failures fixed/);
    assert.match(summary, /bbbbbbb.*fix flaky test/);
    assert.match(summary, /Warning — 1 committed path/);
    assert.match(summary, /user wip\.ts/);
    assert.deepEqual(h.calls.writeState.map((s) => s.lastHead), ['ddddddd9']);
    assert.equal(await inspectProjectRunLock(run.projectPath), null, 'lock released before the next step');
    assert.equal(run.status, 'completed', 'advanced past the step');
    assert.equal(run.testStep, undefined);
    assert.equal(hasActiveRunTestsStep(run.id), false);
  } finally {
    await h.cleanup();
  }
});

test('a spawn failure is noted and the run advances instead of erroring', async () => {
  const h = await setup({
    spawnStep: async (_wf, _run, _i, _o, opts) => {
      opts?.runTests?.onSpawnError('terminal-server down');
      return { command: '', cwd: '' };
    },
  });
  try {
    const run = await startTestRun(h.project, [testStep()]);
    await waitFor(() => run.status !== 'running', 3000, 'advance');
    assert.equal(run.status, 'completed');
    assert.match(run.stepSummaries?.[0] ?? '', /could not start its agent: terminal-server down/);
    assert.equal(h.calls.writeState.length, 0);
    assert.equal(await inspectProjectRunLock(run.projectPath), null);
  } finally {
    await h.cleanup();
  }
});

test('a timeout (measured from the pty spawn) kills the session, lists what it left uncommitted, and advances', async () => {
  let statusCalls = 0;
  const h = await setup({
    minuteMs: 4, // timeoutMinutes 5 → 20 ms
    readStatus: async () => (++statusCalls === 1 ? ['user.ts', 'wip-dir/'] : ['user.ts', 'wip-dir/new.ts', 'agent-left.ts']),
    spawnStep: async (...args) => {
      h.calls.spawn.push(args);
      const [, run, stepIndex] = args;
      // Queue time before the pty exists must not count.
      setTimeout(() => notify({ type: 'step-spawned', runId: run.id, projectPath: run.projectPath, stepIndex, command: 'claude', cwd: '' }), 60);
      return { command: 'claude', cwd: '' };
    },
  });
  try {
    const run = await startTestRun(h.project, [testStep({ timeoutMinutes: 5 })]);
    await waitFor(() => h.calls.spawn.length === 1, 3000, 'spawn');
    await sleep(40);
    assert.equal(run.status, 'running', 'the clock starts at the pty spawn, not the enqueue');
    await waitFor(() => run.status !== 'running', 3000, 'timeout advance');
    assert.equal(h.calls.kill, 1, 'the session was killed');
    const summary = run.stepSummaries?.[0] ?? '';
    assert.match(summary, /Timed out after 5 minute/);
    assert.match(summary, /agent-left\.ts/);
    assert.doesNotMatch(summary, /`user\.ts`|wip-dir\/new\.ts/, "the user's WIP is not reported as the agent's");
    assert.match(summary, /nothing was reverted/);
    assert.equal(h.calls.writeState.length, 0, 'a timed-out run verified nothing');
    assert.equal(await inspectProjectRunLock(run.projectPath), null);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Lock: label, non-lendable, 409 wording, recovery labels
// ---------------------------------------------------------------------------

test('the Run tests lock is not lent: a resolver mutation waits for its release; a merge is refused naming the step', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-runtests-lock-'));
  try {
    const lock = await acquireProjectRunLock(project, runTestsLockLabel('wfrun_x'), { lendable: false });
    let mutated = false;
    const mutation = withProjectMutation(project, async () => { mutated = true; });
    await sleep(120);
    assert.equal(mutated, false, 'a finalize/snapshot must not run under the Run tests agent');

    await assert.rejects(acquireProjectRunLock(project, 'manual-merge'), (err: unknown) => {
      assert.ok(err instanceof ProjectRunLockedError);
      assert.match((err as Error).message, /Run tests step \(run wfrun_x\)/);
      return true;
    });

    await lock.release();
    await mutation;
    assert.equal(mutated, true, 'the deferred mutation runs once the step releases');
    assert.equal(await inspectProjectRunLock(project), null);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('workflow-test locks: exempt from the forced dev restart, never resumed as a merge run', async () => {
  const { isWorkflowLockLabel } = await import('../../scripts/dev/restartPolicy.mjs' as string) as { isWorkflowLockLabel: (l: string) => boolean };
  assert.equal(isWorkflowLockLabel(runTestsLockLabel('wfrun_1')), true);
  assert.equal(isResumableInterruptedRunLock(runTestsLockLabel('wfrun_1')), false);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parsePorcelainZ reads renames (both paths), spaces, quotes and untracked dirs', () => {
  const out = parsePorcelainZ(' M a b.txt\0R  new name.ts\0old "q".ts\0?? dir/\0A  ünï.md\0');
  assert.deepEqual(out, ['a b.txt', 'new name.ts', 'old "q".ts', 'dir/', 'ünï.md']);
  assert.ok(wipCovers(out, 'dir/inner/file.ts'), 'an untracked dir covers what is under it');
  assert.ok(!wipCovers(out, 'other.ts'));
  assert.deepEqual(parseUserWipFile(renderUserWipFile(out)), out);
});

test('readProjectStatusPaths parses a real repo (rename + quoted + untracked dir)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-runtests-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' });
  try {
    git('init', '-q', '-b', 'main');
    await fs.writeFile(path.join(repo, 'old.txt'), 'x');
    await fs.writeFile(path.join(repo, 'a b.txt'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('mv', 'old.txt', 'new.txt');
    await fs.writeFile(path.join(repo, 'a b.txt'), 'changed');
    await fs.mkdir(path.join(repo, 'untracked dir'));
    await fs.writeFile(path.join(repo, 'untracked dir', 'f.txt'), 'x');
    const paths = await readProjectStatusPaths(repo);
    assert.ok(paths);
    assert.deepEqual([...paths!].sort(), ['a b.txt', 'new.txt', 'old.txt', 'untracked dir/'].sort());
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('parseLogNameOnlyZ splits commits and their files', () => {
  const out = parseLogNameOnlyZ('\x1eabc1234\tfix one\0\na.ts\0b c.ts\0\x1edef5678\tsecond\0\nz.ts\0');
  assert.deepEqual(out, [
    { sha: 'abc1234', subject: 'fix one', files: ['a.ts', 'b c.ts'] },
    { sha: 'def5678', subject: 'second', files: ['z.ts'] },
  ]);
  assert.equal(renderPostCheck([], null), '**Commits by this step:** none.');
  assert.equal(composeStepSummary({ notes: [], report: null, reportExpected: true, postCheck: '' }), '_The agent did not write TEST_SUMMARY.md._');
});

test('run-tests.json state parsing rejects junk', () => {
  assert.deepEqual(parseRunTestsState({ lastHead: 'abcdef1', lastFinishedAt: 5 }), { lastHead: 'abcdef1', lastFinishedAt: 5 });
  assert.equal(parseRunTestsState({ lastHead: 'not a sha', lastFinishedAt: 5 }), null);
  assert.equal(parseRunTestsState(null), null);
});

test('recent merged tasks: qa/done since the window, newest first, capped, 3 description lines', () => {
  const t = (i: number, status: Task['status'], mergedAt: number): Task => ({
    id: `t${i}`, projectPath: '/p', title: `Task ${i}`, status, createdAt: 0, mergedAt,
    description: `\nline one\n\nline two\nline three\nline four`,
  });
  const tasks = [t(1, 'qa', 100), t(2, 'done', 300), t(3, 'open', 400), t(4, 'qa', 50), ...Array.from({ length: 40 }, (_, i) => t(10 + i, 'done', 1000 + i))];
  const picked = selectRecentlyMergedTasks(tasks, 100);
  assert.equal(picked.length, 30);
  assert.equal(picked[0].id, 't49');
  assert.ok(!picked.some((x) => x.id === 't3' || x.id === 't4'));
  const block = renderRecentTasksBlock(picked.slice(0, 1), 'since x');
  assert.match(block, /\*\*Task 49\*\* \(done\)\n  > line one\n  > line two\n  > line three$/);
  assert.match(renderRecentTasksBlock([], 'since x'), /No tasks reached QA or Done since x/);
});

test('Run tests brief renders every token for each harness; Pi/Codex get the explicit completion', () => {
  for (const harness of ['claude', 'pi', 'codex'] as const) {
    const md = renderRunTestsBrief({
      harness, projectPath: 'C:\\proj', stepDir: 'C:\\proj\\.lattice\\workflow-steps\\r\\step-0', stepIndex: 2, totalSteps: 4,
      completeUrl: 'http://x/api/workflow-runs/r/steps/2/complete', timeoutMinutes: 60, userWipFile: 'C:\\w\\USER_WIP.txt',
      userWipCount: 3, recentTasksBlock: '- **T**',
    });
    assert.doesNotMatch(md, /\{\{\s*\w+\s*\}\}/, `${harness}: no leftover tokens`);
    assert.match(md, /cd "C:\\proj"/);
    assert.match(md, /step 3 of 4/);
    assert.match(md, /git commit -m "<what you fixed and why>" -- <path>/);
    assert.match(md, /Never\*\* run `git add -A`/);
    assert.match(md, /3 path\(s\)/);
    assert.match(md, /TEST_SUMMARY\.md/);
    if (harness === 'claude') assert.doesNotMatch(md, /curl/);
    else assert.match(md, /curl -s -m 5 -X POST "http:\/\/x\/api\/workflow-runs\/r\/steps\/2\/complete\?source=model-explicit-curl"/);
  }
  assert.ok(getInstructionTemplateDef('run-tests'), 'registered in the Agent prompts catalog');
});

test('Claude gets --add-dir=<project> before the prompt (the variadic flag must not swallow it)', () => {
  const cmd = buildWorkflowStepCommand('/x/RUN_TESTS.md', 'claude', undefined, undefined, { claudeAddDir: '/proj dir' });
  assert.match(cmd, /^claude --dangerously-skip-permissions --add-dir="\/proj dir" "Please read RUN_TESTS\.md/);
  assert.doesNotMatch(buildWorkflowStepCommand('/x/RUN_TESTS.md', 'codex', undefined, undefined, { claudeAddDir: '/p' }), /add-dir/);
});

test('the workflow Push brief pushes only; the QA-lane Push brief is unchanged', () => {
  const wfPush = renderPushInstructions('C:\\proj', DEFAULT_WORKFLOW_PUSH_TEMPLATE);
  assert.doesNotMatch(wfPush, /git add -A|git add \.|git commit -m/);
  assert.match(wfPush, /git push -u origin HEAD/);
  assert.match(wfPush, /cd "C:\\proj"/);
  const qaPush = renderPushInstructions('C:\\proj', DEFAULT_PUSH_TEMPLATE);
  assert.match(qaPush, /git add -A/);
  assert.match(qaPush, /git commit -m/);
  assert.equal(getInstructionTemplateDef('workflow-push')?.filename, 'PUSH_INSTRUCTIONS.md');
});

// ---------------------------------------------------------------------------
// Restart recovery + the stop-hook gate
// ---------------------------------------------------------------------------

async function persistedTestRun(project: string, phase: WorkflowRun['stepPhase']): Promise<WorkflowRun> {
  const wf = await createWorkflow(project, 'Run tests resume', [testStep({ timeoutMinutes: 5 })]);
  return {
    id: `wfrun_resume_${Math.random().toString(36).slice(2, 8)}`,
    workflowId: wf.id, workflowName: wf.name, projectPath: wf.projectPath, status: 'running',
    startedAt: Date.now(), totalSteps: 1, currentStepIndex: 0, definition: wf, stepPhase: phase,
    testStep: { stepIndex: 0, startHead: 'aaaaaaa1', spawnedAt: Date.now() },
  };
}

test('restart: a Run tests step whose terminal is gone is noted and advanced, not errored', async () => {
  const { resumePersistedRun } = await import('../recovery/workflowRunResume.js');
  const h = await setup();
  try {
    const persisted = await persistedTestRun(h.project, 'running');
    await resumePersistedRun(persisted, [], ORIGIN);
    const run = runs.get(persisted.id)!;
    assert.equal(run.status, 'completed');
    assert.match(run.stepSummaries?.[0] ?? '', /Interrupted: .*did not survive the backend restart/);
    assert.equal(h.calls.writeState.length, 0, 'an interrupted run verified nothing');
  } finally {
    await h.cleanup();
  }
});

test('restart: a live Run tests terminal is re-adopted and its project run lock re-taken', async () => {
  const { resumePersistedRun } = await import('../recovery/workflowRunResume.js');
  const h = await setup();
  try {
    const persisted = await persistedTestRun(h.project, 'running');
    const stepDir = workflowStepDir(persisted.projectPath, persisted.id, 0);
    await resumePersistedRun(persisted, [{ id: 'pty-1', cwd: stepDir }], ORIGIN);
    const run = runs.get(persisted.id)!;
    assert.equal(run.status, 'running');
    assert.equal((await inspectProjectRunLock(run.projectPath))?.holder.label, runTestsLockLabel(run.id));
    assert.equal(hasActiveRunTestsStep(run.id), true);
    await completeWorkflowStep(run.id, 0, ORIGIN);
    assert.equal(run.status, 'completed');
    assert.equal(await inspectProjectRunLock(run.projectPath), null, 'released on advance');
  } finally {
    await h.cleanup();
  }
});

test('stop-hook gate: a Run tests step keeps retrying a failing completion checkpoint instead of parking', async () => {
  const { requestStopHookStepComplete, cancelStopHookGate } = await import('../workflowRuns/stopHookGate.js');
  const { forgetAgentQuiescence } = await import('../agentQuiescence.js');
  const { workflowStepAgentId } = await import('../workflowRuns/sessionSpawner.js');
  const runId = 'gate-run-tests-exhausted';
  const run: WorkflowRun = {
    id: runId, workflowId: 'wf', workflowName: 'wf', projectPath: 'C:/gate-project', status: 'running',
    startedAt: 0, totalSteps: 1, currentStepIndex: 0,
    definition: { id: 'wf', name: 'wf', projectPath: 'C:/gate-project', createdAt: 0, variables: [], steps: [testStep()] },
  };
  runs.set(runId, run);
  let attempts = 0;
  try {
    requestStopHookStepComplete(runId, 0, async () => { attempts++; throw new Error('disk full'); }, { settleMs: 2, pollMs: 2, runTestsRetryMs: 5 });
    await sleep(150);
    assert.ok(attempts > 3, `kept retrying past three attempts (got ${attempts})`);
    assert.equal(run.error, undefined, 'no parked-run error for a Run tests step');
  } finally {
    cancelStopHookGate(runId);
    forgetAgentQuiescence(workflowStepAgentId(runId, 0));
    runs.delete(runId);
  }
});
