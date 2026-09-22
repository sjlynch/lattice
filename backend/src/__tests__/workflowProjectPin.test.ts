import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { canonicalProjectPath } from '../projectPath.js';
import { runs, type WorkflowRun } from '../workflowRuns/state.js';
import { flushWorkflowRunPersist, writeWorkflowRunsNow } from '../workflowRuns/persistence.js';
import { createWorkflow, getWorkflow } from '../workflows.js';
import { buildWorkflowCrudRouter } from '../routes/workflows/crud.js';
import { buildWorkflowRunsRouter } from '../routes/workflows/runs.js';

// `PATCH`/`DELETE /api/workflows/:id` and `POST /api/workflow-runs/:runId/cancel`
// look their record up GLOBALLY. When `?project=` is sent it must own the
// record (404 otherwise, nothing written); when it is absent the routes behave
// as before (Stop-hook callbacks and agents may not send it).

async function harness() {
  const a = canonicalProjectPath(await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfpin-a-')));
  const b = canonicalProjectPath(await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfpin-b-')));
  const app = express();
  app.use(express.json());
  app.use(buildWorkflowCrudRouter());
  app.use(buildWorkflowRunsRouter('http://127.0.0.1:1'));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (method: string, url: string, project?: string, body?: unknown) =>
    fetch(`${base}${url}${project !== undefined ? `?project=${encodeURIComponent(project)}` : ''}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return {
    a, b, call,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      for (const p of [a, b]) {
        await flushWorkflowRunPersist(p);
        await writeWorkflowRunsNow(p, []);
        await fs.rm(p, { recursive: true, force: true });
      }
    },
  };
}

test('PATCH /api/workflows/:id honours the ?project= pin', async () => {
  const h = await harness();
  try {
    const wf = await createWorkflow(h.a, 'Original', undefined);
    const foreign = await h.call('PATCH', `/api/workflows/${wf.id}`, h.b, { name: 'Hijacked' });
    assert.equal(foreign.status, 404);
    assert.match((await foreign.json()).hint, /different board/);
    assert.equal((await getWorkflow(wf.id))?.name, 'Original', 'nothing written');

    const own = await h.call('PATCH', `/api/workflows/${wf.id}`, h.a, { name: 'Renamed' });
    assert.equal(own.status, 200);
    assert.equal((await getWorkflow(wf.id))?.name, 'Renamed');

    const unpinned = await h.call('PATCH', `/api/workflows/${wf.id}`, undefined, { name: 'Again' });
    assert.equal(unpinned.status, 200, 'no project → unpinned, as before');
    const empty = await h.call('PATCH', `/api/workflows/${wf.id}`, '', { name: 'Empty' });
    assert.equal(empty.status, 200, 'empty project → unpinned');
    assert.equal((await getWorkflow(wf.id))?.name, 'Empty');
  } finally { await h.close(); }
});

test('DELETE /api/workflows/:id honours the ?project= pin', async () => {
  const h = await harness();
  try {
    const wf = await createWorkflow(h.a, 'Keep me', undefined);
    assert.equal((await h.call('DELETE', `/api/workflows/${wf.id}`, h.b)).status, 404);
    assert.ok(await getWorkflow(wf.id), 'a foreign-project delete removes nothing');
    assert.equal((await h.call('DELETE', `/api/workflows/${wf.id}`, h.a)).status, 200);
    assert.equal(await getWorkflow(wf.id), null);

    const wf2 = await createWorkflow(h.a, 'Unpinned', undefined);
    assert.equal((await h.call('DELETE', `/api/workflows/${wf2.id}`)).status, 200);
    assert.equal((await h.call('DELETE', `/api/workflows/does-not-exist`, h.a)).status, 404);
  } finally { await h.close(); }
});

test('POST /api/workflow-runs/:runId/cancel honours the ?project= pin', async () => {
  const h = await harness();
  const mkRun = (id: string): WorkflowRun => ({
    id, workflowId: 'wf', workflowName: 'WF', projectPath: h.a,
    status: 'running', startedAt: Date.now(), currentStepIndex: 0, totalSteps: 1, stepPhase: 'running',
  });
  const r1 = mkRun(`wfrun_pin_${Date.now()}_1`);
  const r2 = mkRun(`wfrun_pin_${Date.now()}_2`);
  runs.set(r1.id, r1);
  runs.set(r2.id, r2);
  try {
    const foreign = await h.call('POST', `/api/workflow-runs/${r1.id}/cancel`, h.b);
    assert.equal(foreign.status, 404);
    assert.equal(runs.get(r1.id)?.status, 'running', 'a foreign-project cancel leaves the run alone');
    assert.equal((await h.call('POST', `/api/workflow-runs/${r1.id}/cancel`, h.a)).status, 200);
    assert.equal(runs.get(r1.id)?.status, 'cancelled');
    assert.equal((await h.call('POST', `/api/workflow-runs/${r2.id}/cancel`)).status, 200, 'unpinned');
    assert.equal(runs.get(r2.id)?.status, 'cancelled');
  } finally {
    runs.delete(r1.id);
    runs.delete(r2.id);
    await h.close();
  }
});
