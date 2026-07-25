import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

// Regression coverage for the "non-string title/description (or a null batch
// element) returns a cryptic 500 instead of a clean 400" bug. The create /
// batch / upsert routes evaluated `title?.trim()` (and `description?.trim()`
// deep inside createTask) without a type guard, so `{title:123}` threw a
// TypeError that express-async-errors turned into an HTTP 500 with a
// JS-internals message. Every bad-shape payload below must now be rejected
// with a 400 — the same shape the string-path validation returns — and the
// batch path must stay atomic (a bad element creates NOTHING).

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test('task create/batch/upsert reject non-string title/description + null elements with 400', async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'lattice-create-validation-'));
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

    const postJson = (route: string, body: unknown) =>
      fetch(`${base}${route}?project=${projectParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const countTasks = async (): Promise<number> => {
      const res = await fetch(`${base}/api/tasks?project=${projectParam}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { tasks: unknown[] };
      return body.tasks.length;
    };

    const assert400 = async (
      label: string,
      route: string,
      body: unknown,
    ): Promise<void> => {
      const res = await postJson(route, body);
      assert.equal(res.status, 400, `${label}: expected 400, got ${res.status}`);
      const json = (await res.json()) as { error?: string };
      assert.equal(
        typeof json.error,
        'string',
        `${label}: 400 body must carry an { error } message`,
      );
    };

    // ---- POST /api/tasks --------------------------------------------------
    await assert400('create numeric title', '/api/tasks', { title: 123 });
    await assert400('create null title', '/api/tasks', { title: null });
    await assert400('create numeric description', '/api/tasks', {
      title: 'valid title',
      description: 5,
    });

    // ---- POST /api/tasks/batch -------------------------------------------
    await assert400('batch numeric title', '/api/tasks/batch', {
      tasks: [{ title: 123 }],
    });
    await assert400('batch null element', '/api/tasks/batch', { tasks: [null] });
    await assert400('batch numeric description', '/api/tasks/batch', {
      tasks: [{ title: 'ok', description: 7 }],
    });

    // ---- POST /api/tasks/upsert ------------------------------------------
    await assert400('upsert numeric title', '/api/tasks/upsert', {
      tasks: [{ title: 123 }],
    });
    await assert400('upsert null element', '/api/tasks/upsert', { tasks: [null] });
    await assert400('upsert numeric description', '/api/tasks/upsert', {
      tasks: [{ title: 'ok', description: 7 }],
    });

    // Every rejected payload must have created NOTHING.
    assert.equal(await countTasks(), 0, 'no task should have been created by any 400');

    // ---- Atomicity: a good element followed by a bad one creates neither --
    await assert400('batch mixed good/bad is atomic', '/api/tasks/batch', {
      tasks: [{ title: 'good one' }, { title: 456 }],
    });
    assert.equal(
      await countTasks(),
      0,
      'a bad element must not leave the earlier good element half-created',
    );

    // ---- Sanity: valid payloads still succeed ----------------------------
    const okCreate = await postJson('/api/tasks', {
      title: 'a valid task',
      description: 'a valid description',
    });
    assert.equal(okCreate.status, 200, 'valid create still returns 200');
    const okBatch = await postJson('/api/tasks/batch', {
      tasks: [{ title: 'batch a' }, { title: 'batch b', description: 'body' }],
    });
    assert.equal(okBatch.status, 200, 'valid batch still returns 200');
    assert.equal(await countTasks(), 3, 'the three valid tasks landed');

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
