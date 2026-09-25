import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { canonicalProjectPath } from '../projectPath.js';
import { runs, type WorkflowRun } from '../workflowRuns/state.js';
import {
  beginWorkflowRecovery,
  isWorkflowRecoveryDone,
} from '../workflowRuns/recoveryReadiness.js';
import { buildWorkflowRunsWss } from '../ws/endpoints/workflowRuns.js';

// Regression: `/ws/workflow-runs` sent its `hello` (the client's authoritative
// active-runs snapshot) the moment a socket connected, but after a backend
// restart persisted runs are only re-registered once post-listen recovery
// runs. A frontend reconnecting in that window got an EMPTY hello, read its
// queued run as vanished → 'errored', and stopped the workflow queue. The
// hello now says `recovering: true` until recovery is done, then the same
// connection gets a follow-up authoritative hello.

const PROJECT = canonicalProjectPath(
  process.platform === 'win32' ? 'C:\\proj-wf-ws-recovery' : '/proj-wf-ws-recovery',
);

function makeRun(id: string): WorkflowRun {
  return {
    id,
    workflowId: 'wf',
    workflowName: 'WF',
    projectPath: PROJECT,
    status: 'running',
    startedAt: Date.now(),
    currentStepIndex: 0,
    totalSteps: 1,
  } as WorkflowRun;
}

async function startServer() {
  const wss = buildWorkflowRunsWss();
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/ws/workflow-runs?project=${encodeURIComponent(PROJECT)}`,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => r());
      }),
  };
}

async function open(url: string): Promise<{ client: WebSocket; got: Array<Record<string, unknown>> }> {
  const client = new WebSocket(url);
  const got: Array<Record<string, unknown>> = [];
  client.on('message', (data) => got.push(JSON.parse(String(data))));
  await new Promise<void>((res, rej) => { client.once('open', () => res()); client.once('error', rej); });
  return { client, got };
}

async function waitFor(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('hello during recovery is marked recovering, followed by an authoritative hello', async () => {
  const finish = beginWorkflowRecovery();
  const srv = await startServer();
  const run = makeRun(`wfrun_ws_recovery_${Date.now()}`);
  try {
    assert.equal(isWorkflowRecoveryDone(), false);
    const { client, got } = await open(srv.url);
    await waitFor(() => got.length >= 1, 'initial hello');
    assert.deepEqual(got[0], { type: 'hello', runs: [], recovering: true });

    // Recovery registers the persisted run, then declares the registry ready.
    runs.set(run.id, run);
    finish();
    await waitFor(() => got.length >= 2, 'follow-up hello');
    assert.equal(got[1].type, 'hello');
    assert.equal(got[1].recovering, undefined, 'the follow-up is authoritative');
    assert.equal(got[1].projectPath, undefined, 'internal routing field is stripped');
    assert.deepEqual((got[1].runs as WorkflowRun[]).map((r) => r.id), [run.id]);
    client.close();
  } finally {
    finish();
    runs.delete(run.id);
    await srv.close();
  }
});

test('hello after recovery is authoritative and not repeated', async () => {
  const finish = beginWorkflowRecovery();
  finish();
  const srv = await startServer();
  try {
    assert.equal(isWorkflowRecoveryDone(), true);
    const { client, got } = await open(srv.url);
    await waitFor(() => got.length >= 1, 'initial hello');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(got, [{ type: 'hello', runs: [] }]);
    client.close();
  } finally {
    await srv.close();
  }
});

test('a stale finisher from an earlier recovery cannot mark a newer one done', () => {
  const first = beginWorkflowRecovery();
  const second = beginWorkflowRecovery();
  first();
  assert.equal(isWorkflowRecoveryDone(), false);
  second();
  assert.equal(isWorkflowRecoveryDone(), true);
});

// The frontend queue asks GET /api/workflow-runs/:runId when a run leaves its
// active set without a terminal event, to tell "finished while my socket was
// down" from "lost". A finished run must still be readable; `/active` must not
// be shadowed by the `:runId` route.
test('GET /api/workflow-runs/:runId returns a finished run, project-pinned', async () => {
  const { default: express } = await import('express');
  const { buildWorkflowRunsRouter } = await import('../routes/workflows/runs.js');
  const app = express();
  app.use(buildWorkflowRunsRouter('http://127.0.0.1:1'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const finished = { ...makeRun(`wfrun_get_${Date.now()}`), status: 'completed' as const, finishedAt: Date.now() };
  runs.set(finished.id, finished);
  try {
    const ok = await fetch(`${base}/api/workflow-runs/${finished.id}?project=${encodeURIComponent(PROJECT)}`);
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { run: WorkflowRun }).run.status, 'completed');

    const other = process.platform === 'win32' ? 'C:\some-other-proj' : '/some-other-proj';
    const pinned = await fetch(`${base}/api/workflow-runs/${finished.id}?project=${encodeURIComponent(other)}`);
    assert.equal(pinned.status, 404, "another project's run is not served");

    const missing = await fetch(`${base}/api/workflow-runs/wfrun_nope`);
    assert.equal(missing.status, 404);

    const active = await fetch(`${base}/api/workflow-runs/active?project=${encodeURIComponent(PROJECT)}`);
    assert.equal(active.status, 200);
    assert.ok(Array.isArray(await active.json()), '/active still lists runs');
  } finally {
    runs.delete(finished.id);
    await new Promise<void>((r) => server.close(() => r()));
  }
});
