import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import {
  assertNoActiveWorkflowRun,
  startWorkflowRun,
  WorkflowRunConflictError,
} from '../workflowRuns.js';
import { runs, type WorkflowRun } from '../workflowRuns/state.js';
import { createWorkflow } from '../workflows.js';
import { canonicalProjectPath } from '../projectPath.js';
import { buildWorkflowRunsRouter } from '../routes/workflows/runs.js';

// Regression for: "sequential workflow queue let two runs play at once."
// A project runs one workflow at a time: `startWorkflowRun` is the
// authoritative backend guard behind the frontend's best-effort sequential
// gate — it must refuse EVERY start (WorkflowRunConflictError → HTTP 409) while
// a run is already active for the project, whether it came from the queue or a
// manual ▶ Run, so the frontend queues it rather than starting a second run
// alongside the first. (The body flag `requireNoActiveRun` that used to opt in
// is still accepted and ignored.)

function fakeRun(id: string, projectPath: string, status: WorkflowRun['status']): WorkflowRun {
  return {
    id,
    workflowId: 'wf-x',
    workflowName: 'x',
    projectPath,
    status,
    startedAt: 0,
    totalSteps: 1,
    currentStepIndex: 0,
  };
}

test('assertNoActiveWorkflowRun throws only while a run is active for the project', () => {
  // getActiveRunsForProject compares against canonical run.projectPath, so seed
  // the fake runs with canonical paths (drive-cased, resolved separators).
  const project = canonicalProjectPath('C:/guard-project-a');
  const other = canonicalProjectPath('C:/guard-project-b');
  const ids: string[] = [];
  try {
    // No runs → passes.
    assert.doesNotThrow(() => assertNoActiveWorkflowRun(project));

    // A running run in a DIFFERENT project does not gate this one.
    runs.set('r-other', fakeRun('r-other', other, 'running'));
    ids.push('r-other');
    assert.doesNotThrow(() => assertNoActiveWorkflowRun(project));

    // A finished run in this project does not gate either (only 'running' counts).
    runs.set('r-done', fakeRun('r-done', project, 'completed'));
    ids.push('r-done');
    assert.doesNotThrow(() => assertNoActiveWorkflowRun(project));

    // A running run in this project → conflict.
    runs.set('r-live', fakeRun('r-live', project, 'running'));
    ids.push('r-live');
    assert.throws(() => assertNoActiveWorkflowRun(project), WorkflowRunConflictError);
  } finally {
    for (const id of ids) runs.delete(id);
  }
});

test('startWorkflowRun rejects any start while a run is active (before any spawn)', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfguard-'));
  let wfProject = '';
  try {
    const wf = await createWorkflow(project, 'guarded', [
      { id: 's1', title: 'Step 1', prompt: 'do it', harness: 'claude' },
    ]);
    wfProject = wf.projectPath;

    // Simulate a run already active for this project.
    runs.set('r-active', fakeRun('r-active', wf.projectPath, 'running'));

    // The guard fires before any run record / notify / terminal spawn, so this
    // rejects cleanly with no side effects (no new run enters the map).
    await assert.rejects(
      startWorkflowRun(wf.id, 'http://127.0.0.1:5184'),
      WorkflowRunConflictError,
    );

    // Only the pre-seeded active run exists for this project — the rejected
    // start added nothing.
    const forProject = [...runs.values()].filter((r) => r.projectPath === wf.projectPath);
    assert.deepEqual(
      forProject.map((r) => r.id),
      ['r-active'],
      'a rejected start must not create a run record',
    );
  } finally {
    for (const [id, r] of [...runs.entries()]) {
      if (r.projectPath === wfProject) runs.delete(id);
    }
    // Let the workflow store's debounced persist flush before removing the dir.
    await new Promise((r) => setTimeout(r, 200));
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('POST /api/workflows/:id/run 409s a second start for the project even without requireNoActiveRun', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfguard-route-'));
  const app = express();
  app.use(express.json());
  app.use(buildWorkflowRunsRouter('http://127.0.0.1:1'));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let wfProject = '';
  try {
    const wf = await createWorkflow(project, 'guarded', [
      { id: 's1', title: 'Step 1', prompt: 'do it', harness: 'claude' },
    ]);
    wfProject = wf.projectPath;
    runs.set('r-active-route', fakeRun('r-active-route', wf.projectPath, 'running'));

    // A manual ▶ Run sends no flag; an older client may send `false`. Both are
    // refused with the same 409 envelope the frontend queue branches on.
    for (const body of [{}, { requireNoActiveRun: false }]) {
      const res = await fetch(`${base}/api/workflows/${wf.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 409, `body ${JSON.stringify(body)} must 409`);
      const json = (await res.json()) as { error?: string; code?: string };
      assert.equal(json.code, 'active-run-exists');
      assert.match(json.error ?? '', /already active/);
    }
    const forProject = [...runs.values()].filter((r) => r.projectPath === wf.projectPath);
    assert.deepEqual(forProject.map((r) => r.id), ['r-active-route']);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const [id, r] of [...runs.entries()]) {
      if (r.projectPath === wfProject) runs.delete(id);
    }
    await new Promise((r) => setTimeout(r, 200));
    await fs.rm(project, { recursive: true, force: true });
  }
});
