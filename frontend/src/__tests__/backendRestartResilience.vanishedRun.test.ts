// Surviving a backend restart, workflow runs: a mid-recovery `hello` is not
// read as "the run vanished" (a recovering hello merges additively; only an
// authoritative one removes), and the workflow queue asks before declaring a
// vanished run errored — the resolver waits a grace period, reports the
// backend's recorded final status (completed while disconnected → the queue
// cascades), errors a run the backend no longer knows (the queue stops), and
// re-asks an unreachable backend up to a cap. A run dropped by a mid-restart
// hello and then restored keeps the queue running without starting the next
// workflow early. Shared fixtures: backendRestartResilience.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Workflow, WorkflowQueueEntry, WorkflowRun, WorkflowRunStatus } from '../api';
import { HttpError } from '../api/http.ts';
import {
  resolveVanishedRun,
  VANISHED_RUN_GRACE_MS,
  VANISHED_RUN_MAX_UNREACHABLE_MS,
} from '../components/workflows/hooks/vanishedRunResolver.ts';
import { handleWorkflowRunEvent } from '../components/workflows/hooks/useWorkflowRunSubscription.ts';
import type { RunMap } from '../components/workflows/hooks/workflowRunSync.ts';
import type { QueueAction } from '../components/workflows/queueScheduler.ts';
import { useWorkflowQueue } from '../components/workflows/hooks/useWorkflowQueue.ts';
import type { StartOutcome } from '../components/workflows/hooks/useWorkflowRunActions.ts';
import {
  deferredVoid,
  FOLDER,
  installRestartGlobals,
  noSleep,
  run,
  workflows,
} from './backendRestartResilience.fixture.ts';

installRestartGlobals();

// ------------------------------------------------- vanishedRunResolver.ts

test('a vanished run that comes back is not reported', async () => {
  let active = false;
  let fetched = 0;
  const status = await resolveVanishedRun({
    isActive: () => active,
    recentStatus: () => undefined,
    fetchRun: async () => { fetched++; return null; },
    isCancelled: () => false,
    sleep: async () => { active = true; },
  });
  assert.equal(status, null);
  assert.equal(fetched, 0, 'no lookup once the run is back');
});

test("a vanished run reports the backend's recorded final status", async () => {
  const status = await resolveVanishedRun({
    isActive: () => false,
    recentStatus: () => undefined,
    fetchRun: async () => run('r1', 'wf1', { status: 'completed' }),
    isCancelled: () => false,
    sleep: noSleep,
  });
  assert.equal(status, 'completed', 'finished while disconnected → cascades');
});

test('a vanished run unknown to the backend is errored', async () => {
  const status = await resolveVanishedRun({
    isActive: () => false,
    recentStatus: () => undefined,
    fetchRun: async () => null,
    isCancelled: () => false,
    sleep: noSleep,
  });
  assert.equal(status, 'errored');
});

test('an unreachable backend is asked again, and only given up on after the cap', async () => {
  let t = 0;
  let calls = 0;
  const status = await resolveVanishedRun({
    isActive: () => false,
    recentStatus: () => undefined,
    fetchRun: async () => {
      calls++;
      if (calls < 3) throw new HttpError(502, 'down');
      return run('r1', 'wf1', { status: 'completed' });
    },
    isCancelled: () => false,
    sleep: async (ms) => { t += ms; },
    now: () => t,
  });
  assert.equal(status, 'completed');
  assert.equal(calls, 3);

  t = 0;
  const gaveUp = await resolveVanishedRun({
    isActive: () => false,
    recentStatus: () => undefined,
    fetchRun: async () => { throw new TypeError('Failed to fetch'); },
    isCancelled: () => false,
    sleep: async (ms) => { t += ms; },
    now: () => t,
  });
  assert.equal(gaveUp, 'errored');
  assert.ok(t >= VANISHED_RUN_MAX_UNREACHABLE_MS);
});

// --------------------------------------------- recovering hello handling

test('a recovering hello merges additively; an authoritative hello replaces', () => {
  let map: RunMap = { a: run('a'), b: run('b') };
  const setActiveRuns = (next: RunMap | ((cur: RunMap) => RunMap)) => {
    map = typeof next === 'function' ? next(map) : next;
  };
  const args = {
    projectPath: FOLDER,
    addTerminal: () => '',
    setActiveRuns,
    setControlProgress: () => {},
    addRecentRun: () => {},
  } as unknown as Parameters<typeof handleWorkflowRunEvent>[1];

  handleWorkflowRunEvent({ type: 'hello', runs: [], recovering: true }, args);
  assert.deepEqual(Object.keys(map).sort(), ['a', 'b'], 'an empty recovering hello removes nothing');

  handleWorkflowRunEvent({ type: 'hello', runs: [run('c')], recovering: true }, args);
  assert.deepEqual(Object.keys(map).sort(), ['a', 'b', 'c']);

  handleWorkflowRunEvent({ type: 'hello', runs: [run('a')] }, args);
  assert.deepEqual(Object.keys(map), ['a'], 'the authoritative hello is still the removal path');
});

// ------------------------------------------ useWorkflowQueue integration

type QueueProps = {
  activeRuns: Record<string, WorkflowRun>;
  fetchRun: (project: string, runId: string) => Promise<WorkflowRun | null>;
  sleep: (ms: number) => Promise<void>;
};

let latestDispatch: (action: QueueAction) => void = () => {};
let latestState: ReturnType<typeof useWorkflowQueue>['state'] | null = null;
let runCalls: string[] = [];

function QueueHarness({ activeRuns, fetchRun, sleep }: QueueProps) {
  const runWorkflow = React.useCallback(
    (wf: Workflow, e: WorkflowQueueEntry): Promise<StartOutcome> => {
      runCalls.push(wf.id);
      return Promise.resolve({ status: 'started', run: run(`run-${e.id}`, wf.id) });
    },
    [],
  );
  const { state, dispatch } = useWorkflowQueue({
    activeFolder: FOLDER,
    workflowsById: workflows,
    runWorkflow,
    activeRuns,
    recentRuns: {},
    fetchRun,
    vanishedRunTiming: { sleep },
  });
  latestDispatch = dispatch;
  latestState = state;
  return null;
}

async function startTwoQueued(props: QueueProps) {
  runCalls = [];
  let renderer!: ReturnType<typeof TestRenderer.create>;
  // Nothing active yet: the queue dispatches wf1, then the run shows up in
  // activeRuns (as the /run response / WS `started` would put it there).
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(QueueHarness, { ...props, activeRuns: {} }));
  });
  await act(async () => {
    latestDispatch({ type: 'enqueue', entry: { id: 'q1', workflowId: 'wf1', harnessOverride: null } });
    latestDispatch({ type: 'enqueue', entry: { id: 'q2', workflowId: 'wf2', harnessOverride: null } });
    latestDispatch({ type: 'startQueue' });
  });
  await act(async () => {});
  await act(async () => { renderer.update(React.createElement(QueueHarness, props)); });
  assert.deepEqual(runCalls, ['wf1']);
  assert.deepEqual(latestState!.started.map((s) => s.runId), ['run-q1']);
  return renderer;
}

test('queue: a run dropped by a mid-restart hello and then restored keeps the queue running', async () => {
  const grace = deferredVoid();
  let fetched = 0;
  const props: QueueProps = {
    activeRuns: { 'run-q1': run('run-q1') },
    fetchRun: async () => { fetched++; return null; },
    sleep: () => grace.promise,
  };
  const renderer = await startTwoQueued(props);

  // Reconnect to a still-recovering backend: an (old-style) empty hello.
  await act(async () => { renderer.update(React.createElement(QueueHarness, { ...props, activeRuns: {} })); });
  assert.equal(latestState!.running, true, 'not stopped on the spot');
  // Recovery restores the run (progress event / authoritative hello).
  await act(async () => { renderer.update(React.createElement(QueueHarness, { ...props })); });
  await act(async () => { grace.resolve(); });

  assert.equal(fetched, 0);
  assert.equal(latestState!.running, true);
  assert.deepEqual(latestState!.started.map((s) => s.runId), ['run-q1']);
  assert.deepEqual(runCalls, ['wf1'], 'the next workflow did not start early');
  await act(async () => { renderer.unmount(); });
});

async function vanishWith(fetchStatus: WorkflowRunStatus | null) {
  const props: QueueProps = {
    activeRuns: { 'run-q1': run('run-q1') },
    fetchRun: async (project, runId) => {
      assert.equal(project, FOLDER);
      assert.equal(runId, 'run-q1');
      return fetchStatus ? run('run-q1', 'wf1', { status: fetchStatus }) : null;
    },
    sleep: noSleep,
  };
  const renderer = await startTwoQueued(props);
  await act(async () => { renderer.update(React.createElement(QueueHarness, { ...props, activeRuns: {} })); });
  await act(async () => {});
  return renderer;
}

test('queue: a run that completed while disconnected cascades into the next workflow', async () => {
  const renderer = await vanishWith('completed');
  assert.deepEqual(runCalls, ['wf1', 'wf2']);
  await act(async () => { renderer.unmount(); });
});

test('queue: a run the backend no longer knows stops the queue', async () => {
  const renderer = await vanishWith(null);
  assert.deepEqual(runCalls, ['wf1']);
  assert.equal(latestState!.running, false);
  await act(async () => { renderer.unmount(); });
});

// Keep the grace constant honest: the queue test above relies on the resolver
// sleeping before its first lookup.
test('the resolver waits a grace period before its first lookup', async () => {
  const sleeps: number[] = [];
  await resolveVanishedRun({
    isActive: () => false,
    recentStatus: () => 'completed',
    fetchRun: async () => null,
    isCancelled: () => false,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(sleeps, [VANISHED_RUN_GRACE_MS]);
});
