import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import {
  classifyUpsertTarget,
  partitionByProject,
} from '../routes/tasks/crudHandlers.js';
import { canonicalProjectPath } from '../projectPath.js';
import type { Task } from '../tasks.js';

// The defence-in-depth filter inside /api/tasks. The on-disk task store
// at one project's hash dir has been observed to hold tasks tagged for a
// different project (the 2026-05-19 ody/rewrite vs react-chorus incident).
// `partitionByProject` is what makes that invisible to API consumers:
// foreign tasks land in `foreign`, never in `safe`. These tests guard
// against regressions in that filtering — especially around
// canonicalization (case/separator differences must NOT count as foreign).

const ODY = 'C:\\development\\ody\\rewrite';
const RC = 'C:\\development\\react-chorus';

function task(id: string, projectPath: string): Task {
  return {
    id,
    projectPath,
    title: id,
    status: 'open',
    createdAt: 0,
  };
}

test('partitionByProject: all foreign tasks are filtered out', () => {
  const all = [task('a', RC), task('b', RC)];
  const { safe, foreign } = partitionByProject(all, canonicalProjectPath(ODY));
  assert.equal(safe.length, 0);
  assert.equal(foreign.length, 2);
  assert.deepEqual(foreign.map((t) => t.id), ['a', 'b']);
});

test('partitionByProject: mixed list separates matching from foreign', () => {
  const all = [task('a', RC), task('b', ODY), task('c', RC), task('d', ODY)];
  const { safe, foreign } = partitionByProject(all, canonicalProjectPath(ODY));
  assert.deepEqual(safe.map((t) => t.id), ['b', 'd']);
  assert.deepEqual(foreign.map((t) => t.id), ['a', 'c']);
});

test('partitionByProject: empty input yields empty partitions', () => {
  const { safe, foreign } = partitionByProject([], canonicalProjectPath(ODY));
  assert.equal(safe.length, 0);
  assert.equal(foreign.length, 0);
});

test('partitionByProject: case-different drive letters do not count as foreign', () => {
  // Windows path canonicalization uppercases the drive letter. A task
  // whose stored projectPath happens to be lowercase must still match a
  // query for the same project — otherwise the canonical-mismatch filter
  // would scrub legitimate tasks.
  const lowered = 'c:\\development\\ody\\rewrite';
  const { safe, foreign } = partitionByProject(
    [task('a', lowered)],
    canonicalProjectPath(ODY),
  );
  assert.equal(safe.length, 1);
  assert.equal(foreign.length, 0);
});

// ---------- classifyUpsertTarget ----------
//
// The project-scoping guard for POST /api/tasks/upsert?project=X. `updateTask`
// resolves an id across EVERY known project, so before the guard an upsert
// against B containing a {id=...} that actually belongs to A would mutate A's
// task — pasting a round-trip markdown doc from one project into another's
// upsert endpoint silently corrupted the wrong project. The guard fetches the
// existing task and compares canonical project paths, treating a foreign id as
// 'foreign' (reported, never updated) so /upsert only ever touches its own
// project's tasks.

test("classifyUpsertTarget: another project's task id is foreign, never updated", () => {
  // Upsert is scoped to project B (react-chorus); the pasted doc carried
  // project A's (ody/rewrite) task id. It must NOT be updated — A stays
  // untouched and the id is reported as foreign.
  const aTask = task('t_from_A', ODY);
  assert.equal(classifyUpsertTarget(aTask, canonicalProjectPath(RC)), 'foreign');
});

test('classifyUpsertTarget: an unknown id anywhere is missing', () => {
  assert.equal(classifyUpsertTarget(null, canonicalProjectPath(RC)), 'missing');
  assert.equal(classifyUpsertTarget(undefined, canonicalProjectPath(RC)), 'missing');
});

test('classifyUpsertTarget: an id in the same project is updatable', () => {
  const bTask = task('t_in_B', RC);
  assert.equal(classifyUpsertTarget(bTask, canonicalProjectPath(RC)), 'update');
});

test('classifyUpsertTarget: same project via case-different drive still updates', () => {
  // Canonicalization must run on both sides so a lowercase-drive stored path
  // isn't misread as foreign (which would wrongly skip a legitimate update).
  const lowered = task('t_in_B', 'c:\\development\\react-chorus');
  assert.equal(classifyUpsertTarget(lowered, canonicalProjectPath(RC)), 'update');
});

// ---------- /transition (ids) + /bulk-update honour the project pin ----------
//
// Both routes call `updateTask(id)`, a global by-id lookup, and used to ignore
// the `?project=` the by-id routes and /upsert honour (and, later, a project
// sent in the body rather than the query) — so the `lattice` MCP
// `transition_tasks` tool (which always sends project=) could re-lane or
// "delete" another board's task. Drives the real app with two projects.

test('transition and bulk-update pinned to project A (query or body) report B\'s id as foreign and leave it untouched', async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'lattice-scoping-http-'));
  const originalEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const projectA = path.join(tmpHome, 'projA');
  const projectB = path.join(tmpHome, 'projB');
  await mkdir(path.join(projectA, '.git'), { recursive: true });
  await mkdir(path.join(projectB, '.git'), { recursive: true });

  let server: http.Server | null = null;
  try {
    const { createBackendApp } = await import('../server/app.js');
    const { flushPersist } = await import('../tasks.js');
    const app = createBackendApp({ defaultRoot: projectA, backendOrigin: 'http://127.0.0.1:5184' });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = { 'Content-Type': 'application/json' };
    const qA = `project=${encodeURIComponent(projectA)}`;

    const create = async (project: string, title: string) => {
      const res = await fetch(`${base}/api/tasks?project=${encodeURIComponent(project)}`, {
        method: 'POST', headers: json, body: JSON.stringify({ title }),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as { id: string };
    };
    const a = await create(projectA, 'task in A');
    const b = await create(projectB, 'task in B');
    const get = async (id: string) => {
      const res = await fetch(`${base}/api/tasks/${id}`);
      assert.equal(res.status, 200);
      return (await res.json()) as { title: string; status: string };
    };

    // transition by ids, pinned to A, carrying B's id.
    const trRes = await fetch(`${base}/api/tasks/transition?${qA}`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ ids: [a.id, b.id, 'nope'], status: 'done' }),
    });
    assert.equal(trRes.status, 200);
    const tr = (await trRes.json()) as { updated: number; missing: string[]; foreign: string[]; ids: string[] };
    assert.deepEqual(tr, { updated: 1, missing: ['nope'], foreign: [b.id], ids: [a.id] });
    assert.equal((await get(a.id)).status, 'done');
    assert.equal((await get(b.id)).status, 'open', 'B was not re-laned');

    // bulk-update, pinned to A, carrying B's id.
    const buRes = await fetch(`${base}/api/tasks/bulk-update?${qA}`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ updates: [{ id: b.id, title: 'hijacked' }, { id: a.id, title: 'renamed A' }] }),
    });
    assert.equal(buRes.status, 200);
    const bu = (await buRes.json()) as { updated: number; missing: string[]; foreign: string[]; tasks: Array<{ id: string }> };
    assert.equal(bu.updated, 1);
    assert.deepEqual(bu.missing, []);
    assert.deepEqual(bu.foreign, [b.id]);
    assert.deepEqual(bu.tasks.map((t) => t.id), [a.id]);
    assert.equal((await get(b.id)).title, 'task in B', 'B was not renamed');
    assert.equal((await get(a.id)).title, 'renamed A');

    // transition by ids, pinned to A in the BODY (no query), carrying B's id.
    const bodyPinned = await fetch(`${base}/api/tasks/transition`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ ids: [b.id], status: 'deleted', project: projectA }),
    });
    assert.equal(bodyPinned.status, 200);
    assert.deepEqual(await bodyPinned.json(), { updated: 0, missing: [], foreign: [b.id], ids: [] });
    assert.equal((await get(b.id)).status, 'open', 'B was not re-laned by a body-pinned transition');

    // bulk-update pinned to A in the body, carrying B's id.
    const buBody = await fetch(`${base}/api/tasks/bulk-update`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ project: projectA, updates: [{ id: b.id, title: 'hijacked' }] }),
    });
    assert.equal(buBody.status, 200);
    assert.deepEqual(((await buBody.json()) as { foreign: string[] }).foreign, [b.id]);
    assert.equal((await get(b.id)).title, 'task in B', 'B was not renamed by a body-pinned bulk-update');

    // /complete honours an explicit ?project= pin (hook callers send none).
    const completeForeign = await fetch(`${base}/api/tasks/${b.id}/complete?${qA}`, { method: 'POST' });
    assert.equal(completeForeign.status, 404);
    assert.equal((await get(b.id)).status, 'open');

    // No project sent: unchanged global behaviour (B is reachable by id).
    const unpinned = await fetch(`${base}/api/tasks/transition`, {
      method: 'POST', headers: json, body: JSON.stringify({ ids: [b.id], status: 'backlog' }),
    });
    assert.equal(unpinned.status, 200);
    assert.deepEqual(await unpinned.json(), { updated: 1, missing: [], foreign: [], ids: [b.id] });
    assert.equal((await get(b.id)).status, 'backlog');

    await flushPersist(projectA);
    await flushPersist(projectB);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (originalEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = originalEnv.HOME;
    if (originalEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalEnv.USERPROFILE;
    await rm(tmpHome, { recursive: true, force: true });
  }
});
