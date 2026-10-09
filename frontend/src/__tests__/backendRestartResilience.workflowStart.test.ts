// Surviving a backend restart, workflow starts (startWorkflowDefinition): an
// unaccepted start (recovery 503, ECONNREFUSED) retries through the gap and
// allocates once, with no error toast; a lost acknowledgement (network error,
// 504, ECONNRESET) is never replayed — not even once the run settled or was
// cancelled before the browser learned the ack was lost — so ownership is
// never guessed and nothing is resurrected, while a later explicit Run is a
// new intent; a lost start stops its queue without replaying or advancing the
// next entry; an acknowledged finished run keeps its terminal status from HTTP
// or WS. Shared fixtures: backendRestartResilience.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { WorkflowRun } from '../api';
import { installManualTimers } from './domDoubles.ts';
import { handleWorkflowRunEvent } from '../components/workflows/hooks/useWorkflowRunSubscription.ts';
import type { RunMap } from '../components/workflows/hooks/workflowRunSync.ts';
import type { QueueAction } from '../components/workflows/queueScheduler.ts';
import { useWorkflowQueue } from '../components/workflows/hooks/useWorkflowQueue.ts';
import { emptyEditor } from '../components/workflows/editorState.ts';
import {
  useWorkflowRunActions,
  type StartOutcome,
} from '../components/workflows/hooks/useWorkflowRunActions.ts';
import {
  ambiguousFailures,
  deferredVoid,
  FOLDER,
  g,
  installRestartGlobals,
  jsonResponse,
  lostAcknowledgement,
  run,
  workflows,
} from './backendRestartResilience.fixture.ts';

installRestartGlobals();

// The queue the harness below mounts beside the run actions publishes here.
let latestDispatch: (action: QueueAction) => void = () => {};
let latestState: ReturnType<typeof useWorkflowQueue>['state'] | null = null;

// ------------------------------------- startWorkflowDefinition retry path

let latestStart: (id: string) => Promise<StartOutcome> = async () => ({ status: 'failed' });
let added: WorkflowRun[] = [];
let errors: string[] = [];

function RunActionsHarness({ recent = {} }: { recent?: RunMap }) {
  const actions = useWorkflowRunActions({
    activeFolder: FOLDER,
    editor: emptyEditor(),
    workflowsById: workflows,
    save: async () => null,
    addActiveRun: (r) => { added.push(r); },
    getRecentRun: (id) => recent[id] ?? null,
    getWorkflowHarnessOverride: () => null,
    getWorkflowPiModelOverride: () => undefined,
    onError: (msg) => { errors.push(msg); },
  });
  latestStart = (id) => actions.startWorkflowDefinition(id);
  const queue = useWorkflowQueue({
    activeFolder: FOLDER,
    workflowsById: workflows,
    runWorkflow: (wf) => actions.startWorkflowDefinition(wf.id),
    activeRuns: {},
    recentRuns: recent,
  });
  latestDispatch = queue.dispatch;
  latestState = queue.state;
  return null;
}

test('a workflow start retries recovery 503 and ECONNREFUSED before allocating once', async (t) => {
  const timers = installManualTimers();
  t.after(() => timers.restore());
  added = [] as WorkflowRun[];
  errors = [];
  let posts = 0;
  let allocations = 0;
  g.fetch = async (url: string) => {
    if (String(url).includes('/api/workflows/wf1/run')) {
      posts++;
      if (posts === 1) return jsonResponse(503, { error: 'recovering', code: 'workflow-recovering' });
      if (posts === 2) return jsonResponse(502, { error: '[api-proxy]: ECONNREFUSED' });
      allocations++;
      return jsonResponse(200, { run: run('run-new') });
    }
    return jsonResponse(404, {});
  };
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(RunActionsHarness)); });
  t.after(async () => { await act(async () => { renderer.unmount(); }); });
  let pending!: Promise<StartOutcome>;
  await act(async () => { pending = latestStart('wf1'); });
  for (const delay of [1_000, 2_000]) {
    assert.deepEqual(timers.scheduled.map((timer) => timer.delay), [delay]);
    assert.equal(allocations, 0);
    await act(async () => { timers.fireAll(); });
  }
  const outcome = await pending;
  assert.equal(outcome.status, 'started');
  assert.equal(posts, 3);
  assert.equal(allocations, 1);
  assert.deepEqual(errors, [], 'no error toast for a restart');
});

for (const error of ambiguousFailures) {
  for (const status of ['running', 'completed', 'errored', 'cancelled'] as const) {
    test(`workflow ${status} before lost acknowledgement (${error.message}) is never replayed`, async (t) => {
      const timers = installManualTimers();
      t.after(() => timers.restore());
      added = [] as WorkflowRun[];
      errors = [];
      const acknowledgement = deferredVoid();
      const recent: RunMap = {};
      const created: WorkflowRun[] = [];
      const requests: string[] = [];
      g.fetch = async (url: string) => {
        requests.push(String(url));
        assert.ok(String(url).includes('/api/workflows/wf1/run'), 'no timestamp-based active-run lookup');
        const started = run(`run-${created.length + 1}`);
        created.push(started);
        if (created.length === 1) {
          await acknowledgement.promise;
          return lostAcknowledgement(error);
        }
        return jsonResponse(200, { run: started });
      };
      let renderer!: ReturnType<typeof TestRenderer.create>;
      await act(async () => { renderer = TestRenderer.create(React.createElement(RunActionsHarness, { recent })); });
      t.after(async () => { await act(async () => { renderer.unmount(); }); });
      let pending!: Promise<StartOutcome>;
      await act(async () => { pending = latestStart('wf1'); });
      // The server has settled (or the user cancelled) run A before the
      // browser learns that its acknowledgement was lost. Deliver its WS
      // terminal event too: it still cannot identify which click created A.
      const original = { ...created[0], status };
      created[0] = original;
      if (status !== 'running') {
        handleWorkflowRunEvent({ type: status, run: original }, {
          projectPath: FOLDER,
          addTerminal: () => '',
          setActiveRuns: () => {},
          setControlProgress: () => {},
          addRecentRun: (finished) => { recent[finished.id] = finished; },
        });
      }
      await act(async () => { acknowledgement.resolve(); });
      // Advance any retry the old code would have scheduled after 1 second.
      await act(async () => { timers.fireAll(); });
      assert.deepEqual(await pending, { status: 'uncertain' });
      assert.equal(requests.length, 1);
      assert.equal(created.length, 1);
      assert.deepEqual(added, [] as WorkflowRun[], 'no guessed ownership or resurrected run');
      assert.match(errors[0], /could not be confirmed/);
      if (status !== 'running') assert.equal(recent[original.id].status, status);

      if (status !== 'running') {
        let deliberate!: StartOutcome;
        await act(async () => { deliberate = await latestStart('wf1'); });
        assert.equal(deliberate.status, 'started', 'a later explicit Run is a new intent');
        assert.equal(created.length, 2);
        assert.deepEqual(added.map((r) => r.id), ['run-2']);
      }
    });
  }
}

test('a lost workflow start stops its queue without replaying or advancing the next entry', async (t) => {
  const timers = installManualTimers();
  t.after(() => timers.restore());
  added = [] as WorkflowRun[];
  errors = [];
  const posts: string[] = [];
  g.fetch = async (url: string) => {
    posts.push(String(url));
    return lostAcknowledgement(ambiguousFailures[0]);
  };
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(RunActionsHarness)); });
  t.after(async () => { await act(async () => { renderer.unmount(); }); });
  await act(async () => {
    latestDispatch({ type: 'enqueue', entry: { id: 'q1', workflowId: 'wf1', harnessOverride: null } });
    latestDispatch({ type: 'enqueue', entry: { id: 'q2', workflowId: 'wf2', harnessOverride: null } });
    latestDispatch({ type: 'startQueue' });
  });
  await act(async () => { timers.fireAll(); });
  assert.equal(posts.length, 1);
  assert.equal(latestState!.running, false);
  assert.deepEqual(latestState!.queued.map((entry) => entry.id), ['q2']);
  assert.deepEqual(latestState!.started, []);
  assert.match(errors[0], /could not be confirmed/);
});

for (const status of ['completed', 'errored', 'cancelled'] as const) {
  for (const viaSocket of [false, true]) {
    test(`acknowledged ${status} run keeps its terminal status from ${viaSocket ? 'WS' : 'HTTP'}`, async () => {
      added = [] as WorkflowRun[];
      errors = [];
      const finished = run('run-finished', 'wf1', { status });
      const recent = viaSocket ? { [finished.id]: finished } : {};
      g.fetch = async () => jsonResponse(200, { run: viaSocket ? run(finished.id) : finished });
      let renderer!: ReturnType<typeof TestRenderer.create>;
      await act(async () => { renderer = TestRenderer.create(React.createElement(RunActionsHarness, { recent })); });
      let outcome!: StartOutcome;
      await act(async () => { outcome = await latestStart('wf1'); });
      assert.deepEqual(outcome, { status: 'finished', run: finished });
      assert.deepEqual(added, []);
      await act(async () => { renderer.unmount(); });
    });
  }
}
