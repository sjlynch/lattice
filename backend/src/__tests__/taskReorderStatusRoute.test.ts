import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// Regression: POST /api/tasks/reorder used to only check `!status` truthiness,
// so a non-enum status ("garbage") was written onto every listed task and
// persisted — corrupting the board (the task falls out of every lane). It must
// now validate like /transition and PATCH do: reject with 400 and mutate
// nothing.
test('POST /api/tasks/reorder rejects an off-enum status and leaves the task untouched', async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'lattice-task-reorder-status-'));
  const originalEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const project = path.join(tmpHome, 'project');
  await mkdir(project, { recursive: true });
  // Task creation requires a git repo (validateProjectForCreate). A .git marker
  // satisfies the same probe production uses without shelling out to git init.
  await mkdir(path.join(project, '.git'), { recursive: true });

  let server: http.Server | null = null;
  try {
    // Import after redirecting the home env so the task cache singleton writes
    // only inside this test's throwaway Lattice home, not the developer's real
    // ~/.lattice task DB.
    const { createBackendApp } = await import('../server/app.js');
    const { flushPersist } = await import('../tasks.js');

    const app = createBackendApp({
      defaultRoot: project,
      backendOrigin: 'http://127.0.0.1:5184',
    });
    server = http.createServer(app);
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const projectParam = encodeURIComponent(project);

    const createRes = await fetch(`${base}/api/tasks?project=${projectParam}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Reorder status guard' }),
    });
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as { id: string; status: string };
    assert.equal(created.status, 'open');

    // Off-enum status → 400, matching /transition's validation error, and no
    // task mutated.
    const badRes = await fetch(`${base}/api/tasks/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, status: 'garbage', ids: [created.id] }),
    });
    assert.equal(badRes.status, 400);
    const badBody = (await badRes.json()) as { error?: string };
    assert.match(badBody.error ?? '', /status must be one of:/);

    const listRes = await fetch(`${base}/api/tasks?project=${projectParam}`);
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as {
      tasks: Array<{ id: string; status: string }>;
    };
    const afterBad = listBody.tasks.find((t) => t.id === created.id);
    assert.ok(afterBad, 'task should still be returned by GET /api/tasks');
    assert.equal(afterBad.status, 'open');

    // A valid status still reorders (flips the lane + persists).
    const okRes = await fetch(`${base}/api/tasks/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, status: 'in_progress', ids: [created.id] }),
    });
    assert.equal(okRes.status, 200);
    const okBody = (await okRes.json()) as { ok?: boolean };
    assert.equal(okBody.ok, true);

    const listRes2 = await fetch(`${base}/api/tasks?project=${projectParam}`);
    const listBody2 = (await listRes2.json()) as {
      tasks: Array<{ id: string; status: string }>;
    };
    const afterOk = listBody2.tasks.find((t) => t.id === created.id);
    assert.ok(afterOk, 'task should still be returned after a valid reorder');
    assert.equal(afterOk.status, 'in_progress');

    // Regression: a cross-lane move via /reorder must stamp the same
    // timestamps a status PATCH does (updatedAt + doneAt/startedAt/…); a pure
    // same-lane reorder must stamp nothing.
    type StampedTask = {
      id: string;
      status: string;
      sortOrder?: number;
      updatedAt?: number;
      doneAt?: number;
    };
    const getTask = async (id: string): Promise<StampedTask> => {
      const res = await fetch(`${base}/api/tasks/${id}?project=${projectParam}`);
      assert.equal(res.status, 200);
      return (await res.json()) as StampedTask;
    };
    const reorder = async (status: string, ids: string[]): Promise<void> => {
      const res = await fetch(`${base}/api/tasks/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, status, ids }),
      });
      assert.equal(res.status, 200);
    };
    const createOpen = async (title: string): Promise<StampedTask> => {
      const res = await fetch(`${base}/api/tasks?project=${projectParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      assert.equal(res.status, 200);
      const task = (await res.json()) as StampedTask;
      assert.equal(task.status, 'open');
      return task;
    };

    const first = await createOpen('Reorder stamps doneAt (first)');
    const second = await createOpen('Reorder stamps doneAt (second)');
    const before = await getTask(first.id);
    assert.equal(before.doneAt, undefined);

    const beforeMove = Date.now();
    await reorder('done', [first.id, second.id]);
    const moved = await getTask(first.id);
    assert.equal(moved.status, 'done');
    assert.equal(typeof moved.doneAt, 'number');
    assert.ok(moved.doneAt! >= beforeMove, 'doneAt stamped at the move');
    assert.equal(typeof moved.updatedAt, 'number');
    assert.ok(moved.updatedAt! >= beforeMove, 'updatedAt stamped at the move');

    // Let the clock tick so an erroneous re-stamp would be observable.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await reorder('done', [second.id, first.id]);
    const reordered = await getTask(first.id);
    assert.equal(reordered.status, 'done');
    assert.equal(reordered.sortOrder, 1, 'same-lane reorder still rewrites sortOrder');
    assert.equal(reordered.updatedAt, moved.updatedAt, 'same-lane reorder leaves updatedAt');
    assert.equal(reordered.doneAt, moved.doneAt, 'same-lane reorder leaves doneAt');

    await flushPersist(project);
  } finally {
    if (server) await close(server);
    if (originalEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = originalEnv.HOME;
    if (originalEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalEnv.USERPROFILE;
    await rm(tmpHome, { recursive: true, force: true });
  }
});
