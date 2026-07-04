import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

// Regression coverage for the mass-assignment hole on the JSON task-write
// routes. PATCH /api/tasks/:id (JSON) and POST /api/tasks/bulk-update used to
// cast the raw body straight through, so a caller could overwrite internal
// state — most dangerously `worktreePath`, which task cleanup feeds to
// proxyKillSessionsByCwd + `git worktree remove --force`. Only title /
// description / status are part of the documented TaskPatch contract; every
// other field must be ignored while the request still succeeds (200).

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// Internal fields that must NEVER be set by these routes, regardless of status.
// worktreePath is the dangerous one; the rest are state-corruption vectors.
const ALWAYS_IGNORED = {
  worktreePath: 'C:\\',
  branch: 'main',
  conflict: true,
  colorIndex: 999,
  sortOrder: -1,
  harness: 'pi',
} as const;

type TaskShape = Record<string, unknown> & { id: string; status: string };

test('JSON PATCH + bulk-update honor only title/description/status (no mass assignment)', async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'lattice-mass-assign-'));
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

    const fetchTask = async (id: string): Promise<TaskShape> => {
      const res = await fetch(`${base}/api/tasks?project=${projectParam}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { tasks: TaskShape[] };
      const found = body.tasks.find((t) => t.id === id);
      assert.ok(found, `task ${id} should still be listed`);
      return found;
    };

    const assertNoPoison = (task: TaskShape, label: string) => {
      for (const key of Object.keys(ALWAYS_IGNORED) as (keyof typeof ALWAYS_IGNORED)[]) {
        assert.equal(
          task[key],
          undefined,
          `${label}: internal field "${key}" must not be settable over HTTP`,
        );
      }
    };

    // ---- PATCH /api/tasks/:id (JSON) --------------------------------------
    // Status is left unchanged, so the transition-stamped timestamp fields
    // (startedAt/completedAt) must also stay absent even though we send them.
    const createRes = await fetch(`${base}/api/tasks?project=${projectParam}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Original title' }),
    });
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as TaskShape;
    assert.equal(created.status, 'open');

    const patchRes = await fetch(`${base}/api/tasks/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...ALWAYS_IGNORED,
        startedAt: 12345,
        completedAt: 67890,
        title: 'Patched title',
        description: 'Patched description',
      }),
    });
    // The whitelisted fields still land, so the request must succeed.
    assert.equal(patchRes.status, 200);

    const afterPatch = await fetchTask(created.id);
    assert.equal(afterPatch.title, 'Patched title', 'title should be honored');
    assert.equal(
      afterPatch.description,
      'Patched description',
      'description should be honored',
    );
    assert.equal(afterPatch.status, 'open', 'status left untouched');
    assertNoPoison(afterPatch, 'PATCH');
    assert.equal(afterPatch.startedAt, undefined, 'PATCH: startedAt not settable');
    assert.equal(afterPatch.completedAt, undefined, 'PATCH: completedAt not settable');

    // ---- POST /api/tasks/bulk-update -------------------------------------
    // This one DOES transition status (open → in_progress) to prove status is
    // honored. That legitimately stamps startedAt on the server, so we assert
    // the caller-supplied startedAt (12345) did NOT win, rather than absence.
    const create2 = await fetch(`${base}/api/tasks?project=${projectParam}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Second task' }),
    });
    assert.equal(create2.status, 200);
    const second = (await create2.json()) as TaskShape;

    const bulkRes = await fetch(`${base}/api/tasks/bulk-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: [
          {
            id: second.id,
            ...ALWAYS_IGNORED,
            startedAt: 12345,
            title: 'Bulk title',
            status: 'in_progress',
          },
        ],
      }),
    });
    assert.equal(bulkRes.status, 200);
    const bulkBody = (await bulkRes.json()) as { updated: number; tasks: TaskShape[] };
    assert.equal(bulkBody.updated, 1);

    const afterBulk = await fetchTask(second.id);
    assert.equal(afterBulk.title, 'Bulk title', 'bulk title should be honored');
    assert.equal(afterBulk.status, 'in_progress', 'bulk status should be honored');
    assertNoPoison(afterBulk, 'bulk-update');
    // startedAt is server-stamped on the in_progress transition, but must not
    // be the caller-supplied literal.
    assert.notEqual(afterBulk.startedAt, 12345, 'bulk-update: startedAt not settable by caller');
    assert.equal(typeof afterBulk.startedAt, 'number', 'bulk-update: server stamped startedAt');

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
