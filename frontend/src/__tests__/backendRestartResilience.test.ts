import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Workflow, WorkflowQueueEntry, WorkflowRun, WorkflowRunStatus } from '../api';
import { HttpError } from '../api/http.ts';
import {
  isTransientRequestError,
  mayHaveBeenApplied,
  retryTransient,
} from '../api/retry.ts';
import {
  isBackendConnectionDown,
  subscribeBackendConnection,
  subscribeWs,
} from '../api/ws.ts';
import { FakeWebSocket } from './domDoubles.ts';
import {
  resolveVanishedRun,
  VANISHED_RUN_GRACE_MS,
  VANISHED_RUN_MAX_UNREACHABLE_MS,
} from '../components/workflows/hooks/vanishedRunResolver.ts';
import { handleWorkflowRunEvent } from '../components/workflows/hooks/useWorkflowRunSubscription.ts';
import type { RunMap } from '../components/workflows/hooks/workflowRunSync.ts';
import type { QueueAction } from '../components/workflows/queueScheduler.ts';
import { useWorkflowQueue } from '../components/workflows/hooks/useWorkflowQueue.ts';
import { emptyEditor } from '../components/workflows/editorState.ts';
import {
  useWorkflowRunActions,
  type StartOutcome,
} from '../components/workflows/hooks/useWorkflowRunActions.ts';

// Lattice restarts its own backend whenever it merges a backend change into
// itself. These pin the frontend half of surviving that: start actions retry
// through the gap, a mid-recovery `hello` is not read as "the run vanished",
// the workflow queue asks before declaring a vanished run errored, and the
// navbar can tell that the live channels are down.

const FOLDER = 'C:/proj';

function run(id: string, workflowId = 'wf1', over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    workflowId,
    workflowName: `wf ${workflowId}`,
    projectPath: FOLDER,
    status: 'running',
    startedAt: Date.now(),
    totalSteps: 1,
    currentStepIndex: 0,
    ...over,
  };
}

function workflow(id: string): Workflow {
  return { id, name: `wf ${id}`, projectPath: FOLDER, steps: [], variables: [], createdAt: 0 };
}

const noSleep = () => Promise.resolve();

// ---------------------------------------------------------------- retry.ts

test('retryTransient retries 502/503/504 and network errors, then resolves', async () => {
  const errors: unknown[] = [
    new TypeError('Failed to fetch'),
    new HttpError(502, '[api-proxy]: ECONNREFUSED'),
    new HttpError(503, 'workflow recovery is still loading'),
    new HttpError(504, 'gateway timeout'),
  ];
  let calls = 0;
  const retried: unknown[] = [];
  const value = await retryTransient(
    async () => {
      const err = errors[calls++];
      if (err) throw err;
      return 'ok';
    },
    { sleep: noSleep, onRetry: (err) => retried.push(err) },
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 5);
  assert.deepEqual(retried, errors);
});

test('retryTransient throws a real answer (4xx / 500) immediately', async () => {
  for (const status of [400, 404, 409, 500]) {
    let calls = 0;
    await assert.rejects(
      retryTransient(async () => {
        calls++;
        throw new HttpError(status, 'nope');
      }, { sleep: noSleep }),
      (err: unknown) => err instanceof HttpError && err.status === status,
    );
    assert.equal(calls, 1, `status ${status} is not retried`);
  }
});

test('retryTransient stops when cancelled and when the time budget runs out', async () => {
  let calls = 0;
  let cancel = false;
  await assert.rejects(
    retryTransient(async () => {
      calls++;
      if (calls === 2) cancel = true;
      throw new HttpError(502, 'down');
    }, { sleep: noSleep, isCancelled: () => cancel }),
  );
  assert.equal(calls, 2, 'no attempt after cancellation');

  let t = 0;
  calls = 0;
  await assert.rejects(
    retryTransient(async () => {
      calls++;
      throw new HttpError(503, 'down');
    }, {
      sleep: async (ms) => { t += ms; },
      now: () => t,
      maxElapsedMs: 10_000,
    }),
  );
  // 1s + 2s + 4s = 7s; the next 8s wait would exceed the 10s budget.
  assert.equal(calls, 4);
});

test('mayHaveBeenApplied only flags failures that could have reached the backend', () => {
  assert.equal(mayHaveBeenApplied(new HttpError(503, 'recovering')), false);
  assert.equal(mayHaveBeenApplied(new HttpError(502, '[api-proxy]: ECONNREFUSED (x)')), false);
  assert.equal(mayHaveBeenApplied(new HttpError(502, '[api-proxy]: ECONNRESET (x)')), true);
  assert.equal(mayHaveBeenApplied(new HttpError(504, 'timeout')), true);
  assert.equal(mayHaveBeenApplied(new TypeError('Failed to fetch')), true);
  assert.equal(isTransientRequestError(new SyntaxError('bad json')), false);
});

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

const g = globalThis as unknown as Record<string, unknown>;
let savedGlobals: Record<string, unknown>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  savedGlobals = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    WebSocket: g.WebSocket,
    window: g.window,
    fetch: g.fetch,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.WebSocket = FakeWebSocket;
  g.window = { location: { protocol: 'http:', host: 'localhost:5183' } };
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedGlobals)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

type QueueProps = {
  activeRuns: Record<string, WorkflowRun>;
  fetchRun: (project: string, runId: string) => Promise<WorkflowRun | null>;
  sleep: (ms: number) => Promise<void>;
};

let latestDispatch: (action: QueueAction) => void = () => {};
let latestState: ReturnType<typeof useWorkflowQueue>['state'] | null = null;
let runCalls: string[] = [];
const workflows = new Map([['wf1', workflow('wf1')], ['wf2', workflow('wf2')]]);

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

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// ------------------------------------- startWorkflowDefinition retry path

let latestStart: (id: string) => Promise<StartOutcome> = async () => ({ status: 'failed' });
let added: WorkflowRun[] = [];
let errors: string[] = [];

function RunActionsHarness() {
  const actions = useWorkflowRunActions({
    activeFolder: FOLDER,
    editor: emptyEditor(),
    workflowsById: workflows,
    save: async () => null,
    addActiveRun: (r) => { added.push(r); },
    getRecentRun: () => null,
    getWorkflowHarnessOverride: () => null,
    getWorkflowPiModelOverride: () => undefined,
    onError: (msg) => { errors.push(msg); },
  });
  latestStart = (id) => actions.startWorkflowDefinition(id);
  return null;
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

test('a queued start that hits a restarting backend retries instead of failing', async () => {
  added = [];
  errors = [];
  let posts = 0;
  g.fetch = async (url: string) => {
    if (String(url).includes('/api/workflows/wf1/run')) {
      posts++;
      if (posts === 1) return jsonResponse(503, { error: 'recovering', code: 'workflow-recovering' });
      return jsonResponse(200, { run: run('run-new') });
    }
    return jsonResponse(404, {});
  };
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(RunActionsHarness)); });
  let outcome!: StartOutcome;
  await act(async () => { outcome = await latestStart('wf1'); });
  assert.equal(outcome.status, 'started');
  assert.equal(posts, 2);
  assert.deepEqual(errors, [], 'no error toast for a restart');
  await act(async () => { renderer.unmount(); });
});

test('a 409 after a lost-response attempt adopts our own run instead of requeuing', async () => {
  added = [];
  errors = [];
  let posts = 0;
  const own = run('run-own');
  g.fetch = async (url: string) => {
    const raw = String(url);
    if (raw.includes('/api/workflows/wf1/run')) {
      posts++;
      if (posts === 1) return jsonResponse(502, { error: '[api-proxy]: ECONNRESET (socket hang up)' });
      return jsonResponse(409, { error: 'busy', code: 'active-run-exists' });
    }
    if (raw.includes('/api/workflow-runs/active')) return jsonResponse(200, [own]);
    return jsonResponse(404, {});
  };
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(RunActionsHarness)); });
  let outcome!: StartOutcome;
  await act(async () => { outcome = await latestStart('wf1'); });
  assert.deepEqual(outcome, { status: 'started', run: own });
  assert.deepEqual(added.map((r) => r.id), ['run-own']);
  await act(async () => { renderer.unmount(); });
});

// ------------------------------------------------ connection indicator

test('backend connection is "down" while any live channel is reconnecting', () => {
  const seen: boolean[] = [];
  const unsubHealth = subscribeBackendConnection((down) => seen.push(down));
  const unsubA = subscribeWs('/ws/a?project=x', () => {});
  const unsubB = subscribeWs('/ws/b?project=x', () => {});
  const [a, b] = FakeWebSocket.instances;
  a.serverAccept();
  b.serverAccept();
  assert.equal(isBackendConnectionDown(), false);

  a.serverDrop();
  b.serverDrop();
  assert.equal(isBackendConnectionDown(), true);
  unsubA();
  assert.equal(isBackendConnectionDown(), true, 'b is still down');
  unsubB();
  assert.equal(isBackendConnectionDown(), false, 'torn-down channels never count');
  assert.deepEqual(seen, [true, false], 'notified once per transition');
  unsubHealth();
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
