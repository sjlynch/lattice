import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Workflow, WorkflowQueueEntry, WorkflowRun } from '../api';
import type { QueueAction } from '../components/workflows/queueScheduler.ts';
import type { StartOutcome } from '../components/workflows/hooks/useWorkflowRunActions.ts';
import { BUSY_RETRY_DELAY_MS, useWorkflowQueue } from '../components/workflows/hooks/useWorkflowQueue.ts';
import { installManualTimers, type ManualTimers } from './domDoubles.ts';

// HTTP can stay healthy while the workflow socket is stale. A 409 must keep
// the FIFO head and its overrides without retrying at round-trip speed.
const folder = 'C:/p';

function workflow(id: string, projectPath = folder): Workflow {
  return { id, name: 'wf ' + id, projectPath, steps: [], variables: [], createdAt: 0 };
}

function run(id: string, workflowId = 'wf1', projectPath = folder): WorkflowRun {
  return {
    id, workflowId, workflowName: 'wf ' + workflowId, projectPath,
    status: 'running', startedAt: 0, totalSteps: 1, currentStepIndex: 0,
  };
}

function entry(id: string, workflowId = 'wf1'): WorkflowQueueEntry {
  return { id, workflowId, harnessOverride: null };
}

function deferredOutcome() {
  let resolve!: (outcome: StartOutcome) => void;
  const promise = new Promise<StartOutcome>((done) => { resolve = done; });
  return { promise, resolve };
}

let latestDispatch: (action: QueueAction) => void = () => {};
let latestState: ReturnType<typeof useWorkflowQueue>['state'] | null = null;
let runCalls: WorkflowQueueEntry[];
let timers: ManualTimers;
let renderer: ReturnType<typeof TestRenderer.create> | null;
let props: React.ComponentProps<typeof Harness>;

function Harness(args: Parameters<typeof useWorkflowQueue>[0]) {
  const { state, dispatch } = useWorkflowQueue(args);
  latestDispatch = dispatch;
  latestState = state;
  return null;
}

async function mount(start: (wf: Workflow, e: WorkflowQueueEntry) => Promise<StartOutcome>) {
  props = {
    activeFolder: folder,
    workflowsById: new Map([['wf1', workflow('wf1')], ['wf2', workflow('wf2')]]),
    activeRuns: {},
    recentRuns: {},
    runWorkflow: (wf, e) => {
      runCalls.push(e);
      return start(wf, e);
    },
  };
  await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, props)); });
}

async function update(changes: Partial<typeof props>) {
  props = { ...props, ...changes };
  await act(async () => { renderer!.update(React.createElement(Harness, props)); });
}

async function dispatch(...actions: QueueAction[]) {
  await act(async () => { actions.forEach((action) => latestDispatch(action)); });
}

async function startQueue(...entries: WorkflowQueueEntry[]) {
  await dispatch(...entries.map((e): QueueAction => ({ type: 'enqueue', entry: e })), { type: 'startQueue' });
}

async function expireRetry() {
  assert.equal(timers.scheduled.length, 1, 'only one retry timer exists');
  assert.equal(timers.scheduled[0].delay, BUSY_RETRY_DELAY_MS);
  assert.ok(BUSY_RETRY_DELAY_MS >= 1_000, 'busy retries must be bounded to seconds');
  await act(async () => { timers.fireAll(); });
}

const g = globalThis as unknown as Record<string, unknown>;
let savedActEnv: unknown;

beforeEach(() => {
  runCalls = [];
  latestState = null;
  renderer = null;
  timers = installManualTimers();
  savedActEnv = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  timers.restore();
  if (savedActEnv === undefined) delete g.IS_REACT_ACT_ENVIRONMENT;
  else g.IS_REACT_ACT_ENVIRONMENT = savedActEnv;
});

test('sustained 409s are delayed, single-flight and FIFO with overrides intact', async () => {
  const accepted = deferredOutcome();
  await mount((wf, e) => {
    if (runCalls.length <= 3) return Promise.resolve({ status: 'busy' });
    if (runCalls.length === 4) return accepted.promise;
    return Promise.resolve({ status: 'started', run: run('run-' + e.id, wf.id) });
  });
  const first = { ...entry('q1'), harnessOverride: 'pi' as const, piModelOverride: 'vllm/gpt' };
  const second = entry('q2', 'wf2');
  await startQueue(first, second);

  for (let attempts = 1; attempts <= 3; attempts++) {
    assert.equal(runCalls.length, attempts, 'a busy response does not retry immediately');
    assert.deepEqual(latestState!.queued, [first, second]);
    assert.deepEqual(latestState!.started, []);
    assert.equal(latestState!.running, true);
    const pending = timers.scheduled[0];
    // Re-renders and unrelated lifecycle events cannot shorten or reset backoff.
    await update({ activeRuns: {} });
    await dispatch({ type: 'runFinished', runId: 'manual-' + attempts, status: 'errored' });
    assert.equal(runCalls.length, attempts);
    assert.equal(timers.scheduled[0], pending);
    await expireRetry();
  }

  assert.equal(runCalls.length, 4);
  assert.deepEqual(runCalls, [first, first, first, first]);
  assert.equal(latestState!.started[0].runId, null, 'the accepted response is still pending');
  assert.deepEqual(latestState!.queued, [second]);
  assert.equal(timers.scheduled.length, 0, 'no timer races a pending HTTP request');
  await act(async () => { timers.fireAll(); });
  assert.equal(runCalls.length, 4);

  await act(async () => { accepted.resolve({ status: 'started', run: run('run-q1') }); });
  assert.equal(latestState!.started[0].runId, 'run-q1');
  await dispatch({ type: 'runFinished', runId: 'run-q1', status: 'completed' });
  assert.deepEqual(runCalls, [first, first, first, first, second]);
});

for (const releaseFirst of [true, false]) {
  test('a visible blocker releases ' + (releaseFirst ? 'before' : 'after') + ' the retry delay', async () => {
    await mount(() => Promise.resolve(runCalls.length === 1
      ? { status: 'busy' }
      : { status: 'started', run: run('run-q1') }));
    await startQueue(entry('q1'));
    const blocker = run('manual');
    await update({ activeRuns: { manual: blocker } });
    const release = () => update({
      activeRuns: {}, recentRuns: { manual: { ...blocker, status: 'cancelled' } },
    });

    if (releaseFirst) await release();
    else await expireRetry();
    assert.equal(runCalls.length, 1, 'both the delay and occupied slot must clear');
    assert.equal(latestState!.running, true, 'a manual cancellation does not stop this queue');
    if (releaseFirst) await expireRetry();
    else await release();

    assert.equal(runCalls.length, 2);
    assert.equal(latestState!.started[0].runId, 'run-q1');
    assert.equal(timers.scheduled.length, 0);
  });
}

for (const action of ['stopQueue', 'removeFromQueue', 'clearQueue', 'unmount'] as const) {
  test(action + ' cancels a pending busy retry', async () => {
    await mount(() => Promise.resolve({ status: 'busy' }));
    await startQueue(entry('q1'));
    const staleTimer = timers.scheduled[0];
    assert.ok(staleTimer);

    if (action === 'unmount') {
      await act(async () => { renderer!.unmount(); });
      renderer = null;
    } else {
      await dispatch(action === 'removeFromQueue'
        ? { type: action, entryId: 'q1' }
        : { type: action });
      assert.equal(latestState!.deferredRetry, null);
      assert.equal(latestState!.running, false);
      assert.deepEqual(latestState!.queued.map((e) => e.id), action === 'stopQueue' ? ['q1'] : []);
    }
    assert.equal(timers.scheduled.length, 0);
    // Even a callback already queued by the browser cannot act after cleanup.
    await act(async () => { staleTimer.cb(); });
    assert.equal(runCalls.length, 1);

    if (action === 'stopQueue') {
      await dispatch({ type: 'startQueue' });
      assert.equal(runCalls.length, 2, 'explicit restart still works');
      const newTimer = timers.scheduled[0];
      await act(async () => { staleTimer.cb(); });
      assert.equal(runCalls.length, 2, 'old callback cannot release a new retry for the same entry');
      assert.equal(timers.scheduled[0], newTimer);
    }
  });
}

for (const outcomeStatus of ['busy', 'finished'] as const) {
  for (const action of ['stopQueue', 'unmount'] as const) {
    test('a ' + outcomeStatus + ' response arriving after ' + action + ' cannot schedule more work', async () => {
      const pending = deferredOutcome();
      await mount(() => pending.promise);
      await startQueue(entry('q1'), entry('q2', 'wf2'));
      if (action === 'unmount') {
        await act(async () => { renderer!.unmount(); });
        renderer = null;
      } else {
        await dispatch({ type: 'stopQueue' });
      }
      await act(async () => {
        pending.resolve(outcomeStatus === 'busy'
          ? { status: 'busy' }
          : { status: 'finished', run: { ...run('run-q1'), status: 'completed' } });
      });
      assert.equal(runCalls.length, 1);
      assert.equal(timers.scheduled.length, 0);
      if (action === 'stopQueue') {
        assert.equal(latestState!.running, false);
        assert.deepEqual(
          latestState!.queued.map((e) => e.id),
          outcomeStatus === 'busy' ? ['q1', 'q2'] : ['q2'],
        );
        assert.deepEqual(latestState!.started, []);
      }
    });
  }
}

test('A-to-B-to-A project switches fence pending responses and retry timers', async () => {
  const oldRequest = deferredOutcome();
  const newRequest = deferredOutcome();
  await mount(() => {
    if (runCalls.length === 1) return oldRequest.promise;
    if (runCalls.length === 2) return newRequest.promise;
    return Promise.resolve({ status: 'busy' });
  });
  await startQueue(entry('q1'));
  const mapA = props.workflowsById;
  const switchBack = async () => {
    await update({ activeFolder: 'C:/b', workflowsById: new Map() });
    assert.deepEqual(latestState!.queued, []);
    assert.equal(latestState!.deferredRetry, null);
    await update({ activeFolder: folder, workflowsById: mapA });
  };

  await switchBack();
  await startQueue(entry('q1'));
  const newStarted = latestState!.started;
  await act(async () => { oldRequest.resolve({ status: 'busy' }); });
  assert.equal(latestState!.started, newStarted, 'old response cannot requeue the new in-flight entry');
  assert.equal(latestState!.deferredRetry, null);
  assert.equal(timers.scheduled.length, 0);
  assert.equal(runCalls.length, 2);

  await act(async () => { newRequest.resolve({ status: 'busy' }); });
  const timer = timers.scheduled[0];
  assert.ok(timer);
  await switchBack();
  assert.equal(timers.scheduled.length, 0);
  await startQueue(entry('q1'));
  const currentTimer = timers.scheduled[0];
  await act(async () => { timer.cb(); });
  assert.equal(runCalls.length, 3, 'old timer cannot release admission in the new project lifetime');
  assert.equal(timers.scheduled[0], currentTimer);
  await expireRetry();
  assert.equal(runCalls.length, 4, 'the current project still retries');
});

for (const status of ['errored', 'cancelled'] as const) {
  for (const source of ['active diff', 'finished outcome'] as const) {
    test('early ' + status + ' from ' + source + ' after a busy retry stops the next entry', async () => {
      const pending = deferredOutcome();
      await mount(() => runCalls.length === 1 ? Promise.resolve({ status: 'busy' }) : pending.promise);
      await startQueue(entry('q1'), entry('q2', 'wf2'));
      const staleTimer = timers.scheduled[0];
      await expireRetry();

      const ownedRun = run('run-q1');
      const finished = { ...ownedRun, status };
      if (source === 'active diff') {
        await update({ activeRuns: { [ownedRun.id]: ownedRun } });
        await update({ activeRuns: {}, recentRuns: { [ownedRun.id]: finished } });
      }
      await act(async () => {
        pending.resolve(source === 'active diff'
          ? { status: 'started', run: ownedRun }
          : { status: 'finished', run: finished });
      });

      assert.equal(latestState!.running, false);
      assert.deepEqual(latestState!.queued.map((e) => e.id), ['q2']);
      assert.deepEqual(latestState!.started, []);
      assert.equal(timers.scheduled.length, 0);
      await act(async () => { staleTimer.cb(); });
      await dispatch({ type: 'runFinished', runId: 'manual', status: 'completed' });
      assert.equal(runCalls.length, 2, 'neither a deferred retry nor a lifecycle update restarts the queue');
    });
  }
}
