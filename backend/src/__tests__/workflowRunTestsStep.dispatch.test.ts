// The workflow "Run tests" step ('test' kind): an agent step with a fixed brief
// that never stops the workflow. These pin its dispatch (the agent spawner with
// the Run tests brief, under a workflow-test lock), the skip rule (HEAD
// unchanged since the last Run tests, or detached: a note, no spawn, no lock),
// the normal finish (TEST_SUMMARY.md + the post-check, run-tests.json recorded
// at the FINISH head, lock released) and that a spawn failure or a timeout —
// measured from the pty spawn, not the enqueue — is noted and advanced instead
// of erroring. Harness: helpers/workflowRunTestsStep.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { completeWorkflowStep } from '../workflowRuns.js';
import { notify } from '../workflowRuns/state.js';
import { hasActiveRunTestsStep, runTestsLockLabel } from '../workflowRuns/testStep/runTestsStep.js';
import { workflowStepDir } from '../workflowRuns/scratchDirectory.js';
import { inspectProjectRunLock } from '../projectRunLock.js';
import { ORIGIN, setup, sleep, startTestRun, testStep, waitFor } from './helpers/workflowRunTestsStep.js';

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
