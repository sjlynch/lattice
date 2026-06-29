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

test('PATCH /api/tasks/:id rejects an invalid JSON status and leaves the task in its original lane', async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'lattice-task-patch-status-'));
  const originalEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const project = path.join(tmpHome, 'project');
  await mkdir(project, { recursive: true });

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
      body: JSON.stringify({ title: 'Status validation guard' }),
    });
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as { id: string; status: string };
    assert.equal(created.status, 'open');

    const patchRes = await fetch(`${base}/api/tasks/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'qa_done' }),
    });
    assert.equal(patchRes.status, 400);
    const patchBody = (await patchRes.json()) as { error?: string };
    assert.match(patchBody.error ?? '', /status must be one of:/);

    const listRes = await fetch(`${base}/api/tasks?project=${projectParam}`);
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as {
      tasks: Array<{ id: string; status: string }>;
    };
    const afterPatch = listBody.tasks.find((t) => t.id === created.id);
    assert.ok(afterPatch, 'task should still be returned by GET /api/tasks');
    assert.equal(afterPatch.status, 'open');

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
