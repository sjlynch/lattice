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

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

interface TwoProjectApp {
  base: string;
  projectA: string;
  projectB: string;
  qA: string;
  create: (project: string, title: string) => Promise<{ id: string }>;
  get: (id: string) => Promise<{ title: string; status: string; summary?: string }>;
  post: (url: string, body: unknown) => Promise<FetchResponse>;
}

// In-process backend app over a throwaway HOME holding two projects (A, B),
// so a request pinned to A can be aimed at B's task ids.
async function withTwoProjectApp(fn: (ctx: TwoProjectApp) => Promise<void>): Promise<void> {
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

    const create = async (project: string, title: string) => {
      const res = await fetch(`${base}/api/tasks?project=${encodeURIComponent(project)}`, {
        method: 'POST', headers: json, body: JSON.stringify({ title }),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as { id: string };
    };
    const get = async (id: string) => {
      const res = await fetch(`${base}/api/tasks/${id}`);
      assert.equal(res.status, 200);
      return (await res.json()) as { title: string; status: string; summary?: string };
    };
    const post = (url: string, body: unknown) =>
      fetch(`${base}${url}`, { method: 'POST', headers: json, body: JSON.stringify(body) });

    await fn({
      base, projectA, projectB, qA: `project=${encodeURIComponent(projectA)}`, create, get, post,
    });

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
}

test("transition and bulk-update pinned to project A (query or body) report B's id as foreign and leave it untouched", async () => {
  await withTwoProjectApp(async ({ base, projectA, projectB, qA, create, get }) => {
    const json = { 'Content-Type': 'application/json' };
    const a = await create(projectA, 'task in A');
    const b = await create(projectB, 'task in B');

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
  });
});

// ---------- PATCH / append-summary / DELETE honour the project pin ----------
//
// `getTask(id)` resolves across every board, so these by-id writes rely on
// `requireTaskInRequestedProject` to refuse a foreign id when `?project=` is
// sent — the `lattice` MCP `update_task` / `append_summary` / `delete_task`
// tools always send it. A regression would let them silently rewrite or delete
// another project's task.

test("PATCH, append-summary and DELETE pinned to project A 404 on B's id and leave B untouched", async () => {
  await withTwoProjectApp(async ({ base, projectA, projectB, qA, create, get, post }) => {
    const a = await create(projectA, 'task in A');
    const b = await create(projectB, 'task in B');
    const patch = (id: string, body: unknown) => fetch(`${base}/api/tasks/${id}?${qA}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const assertDifferentBoard = async (res: FetchResponse, what: string) => {
      assert.equal(res.status, 404, `${what} should 404`);
      const body = (await res.json()) as { error: string; hint?: string };
      assert.equal(body.error, 'not found');
      assert.match(body.hint ?? '', /different board/, `${what} names the wrong board`);
      assert.ok(body.hint?.includes(b.id), `${what} names the task`);
    };

    await assertDifferentBoard(await patch(b.id, { title: 'hijacked', status: 'done' }), 'PATCH');
    const afterPatch = await get(b.id);
    assert.equal(afterPatch.title, 'task in B', 'B was not renamed');
    assert.equal(afterPatch.status, 'open', 'B was not re-laned');

    const summary = await post(`/api/tasks/${b.id}/append-summary?${qA}`, { summary: 'hijacked summary' });
    await assertDifferentBoard(summary, 'append-summary');
    assert.equal((await get(b.id)).summary, undefined, 'no summary was appended to B');

    const del = await fetch(`${base}/api/tasks/${b.id}?${qA}`, { method: 'DELETE' });
    await assertDifferentBoard(del, 'DELETE');
    assert.equal((await get(b.id)).title, 'task in B', 'B still exists');

    // A blank summary is a 400 before any lookup.
    const blank = await post(`/api/tasks/${a.id}/append-summary?${qA}`, { summary: '   ' });
    assert.equal(blank.status, 400);
    assert.deepEqual(await blank.json(), { error: 'summary required' });

    // The same pinned calls against A's own task go through.
    assert.equal((await patch(a.id, { title: 'renamed A' })).status, 200);
    assert.equal((await get(a.id)).title, 'renamed A');
    const ownSummary = await post(`/api/tasks/${a.id}/append-summary?${qA}`, { summary: 'did the thing' });
    assert.equal(ownSummary.status, 200);
    assert.match((await get(a.id)).summary ?? '', /did the thing/);
    const ownDelete = await fetch(`${base}/api/tasks/${a.id}?${qA}`, { method: 'DELETE' });
    assert.equal(ownDelete.status, 200);
    assert.equal((await fetch(`${base}/api/tasks/${a.id}`)).status, 404, 'A was deleted');
    assert.equal((await get(b.id)).title, 'task in B', "B survived A's delete");
  });
});

// ---------- a drive-relative project is a 400; a body project pins by-id routes ----------
//
// A shell that strips backslashes turns `C:\dev\proj` into `C:devproj`, which
// canonicalProjectPath resolves under the backend's cwd. /bulk-update used to
// class every id `foreign` against that bogus path and answer 200
// {updated: 0} — writing nothing, silently. And the by-id routes read the pin
// from the query only, so a body `{project}` there was ignored and a foreign
// id was written.

test('bulk-update 400s a drive-relative project; by-id routes honour a body project pin', async () => {
  await withTwoProjectApp(async ({ base, projectA, qA, projectB, create, get, post }) => {
    const a = await create(projectA, 'task in A');
    const b = await create(projectB, 'task in B');

    const relBody = await post('/api/tasks/bulk-update', {
      project: 'C:foo', updates: [{ id: a.id, title: 'mangled' }],
    });
    assert.equal(relBody.status, 400);
    assert.equal((await get(a.id)).title, 'task in A', 'nothing written for a drive-relative body project');

    const relQuery = await post(`/api/tasks/bulk-update?project=${encodeURIComponent('C:foo')}`, {
      updates: [{ id: a.id, title: 'mangled' }],
    });
    assert.equal(relQuery.status, 400);
    assert.equal((await get(a.id)).title, 'task in A', 'nothing written for a drive-relative query project');

    // PATCH / append-summary with B's id and A named in the BODY: a 404.
    const patchForeign = await fetch(`${base}/api/tasks/${b.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectA, title: 'hijacked' }),
    });
    assert.equal(patchForeign.status, 404);
    assert.equal((await get(b.id)).title, 'task in B', 'B was not renamed by a body-pinned PATCH');

    const summaryForeign = await post(`/api/tasks/${b.id}/append-summary`, {
      project: projectA, summary: 'hijacked summary',
    });
    assert.equal(summaryForeign.status, 404);
    assert.equal((await get(b.id)).summary, undefined, 'no summary was appended to B');

    // A drive-relative pin on a by-id route is a 400, not a "wrong board" 404.
    const patchRel = await fetch(`${base}/api/tasks/${a.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'C:foo', title: 'mangled' }),
    });
    assert.equal(patchRel.status, 400);
    assert.equal((await get(a.id)).title, 'task in A');

    // The query still wins over the body, and a body pin naming the task's own
    // board goes through.
    const queryWins = await fetch(`${base}/api/tasks/${a.id}?${qA}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectB, title: 'renamed A' }),
    });
    assert.equal(queryWins.status, 200);
    const ownBody = await fetch(`${base}/api/tasks/${b.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectB, title: 'renamed B' }),
    });
    assert.equal(ownBody.status, 200);
    assert.equal((await get(a.id)).title, 'renamed A');
    assert.equal((await get(b.id)).title, 'renamed B');
  });
});

// ---------- /transition {fromStatus, project} lane sweep ----------
//
// The lane sweep lists ONE project's tasks, so it must move exactly that
// board's lane — `transition_tasks({fromStatus})` mass-moving the wrong board
// is the failure mode this guards. Explicit `ids` win over `fromStatus`.

test("transition {fromStatus, project} sweeps only that project's lane; ids take precedence; bad input is 400", async () => {
  await withTwoProjectApp(async ({ projectA, projectB, create, get, post }) => {
    const a1 = await create(projectA, 'A qa 1');
    const a2 = await create(projectA, 'A qa 2');
    const aOpen = await create(projectA, 'A open');
    const b1 = await create(projectB, 'B qa 1');
    const b2 = await create(projectB, 'B qa 2');
    const toQa = await post('/api/tasks/transition', { ids: [a1.id, a2.id, b1.id, b2.id], status: 'qa' });
    assert.equal(toQa.status, 200);
    assert.equal(((await toQa.json()) as { updated: number }).updated, 4);

    // ids given together with fromStatus: only the ids move.
    const byIds = await post('/api/tasks/transition', {
      ids: [a1.id], fromStatus: 'qa', project: projectA, status: 'done',
    });
    assert.equal(byIds.status, 200);
    assert.deepEqual(await byIds.json(), { updated: 1, missing: [], foreign: [], ids: [a1.id] });
    assert.equal((await get(a1.id)).status, 'done');
    assert.equal((await get(a2.id)).status, 'qa', "the rest of A's qa lane stayed put");

    // Lane sweep pinned to A: exactly A's qa tasks move, B's stay.
    await post('/api/tasks/transition', { ids: [a1.id], status: 'qa' });
    const sweep = await post('/api/tasks/transition', { fromStatus: 'qa', project: projectA, status: 'done' });
    assert.equal(sweep.status, 200);
    const swept = (await sweep.json()) as { updated: number; missing: string[]; foreign: string[]; ids: string[] };
    assert.equal(swept.updated, 2);
    assert.deepEqual(swept.missing, []);
    assert.deepEqual(swept.foreign, []);
    assert.deepEqual([...swept.ids].sort(), [a1.id, a2.id].sort());
    assert.equal((await get(a1.id)).status, 'done');
    assert.equal((await get(a2.id)).status, 'done');
    assert.equal((await get(aOpen.id)).status, 'open', "A's other lanes untouched");
    assert.equal((await get(b1.id)).status, 'qa', "B's qa lane untouched");
    assert.equal((await get(b2.id)).status, 'qa', "B's qa lane untouched");

    // An empty lane is a no-op, not an error.
    const empty = await post('/api/tasks/transition', { fromStatus: 'qa', project: projectA, status: 'done' });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { updated: 0, missing: [], foreign: [], ids: [] });

    // Invalid fromStatus → 400.
    const bad = await post('/api/tasks/transition', { fromStatus: 'bogus', project: projectB, status: 'done' });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /^fromStatus must be one of/);

    // Neither ids nor fromStatus+project → 400 (fromStatus alone is not enough).
    const expected = { error: 'provide either { ids: [...] } or { fromStatus, project }' };
    for (const body of [{ status: 'done' }, { fromStatus: 'qa', status: 'done' }, { ids: [], status: 'done' }]) {
      const res = await post('/api/tasks/transition', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), expected);
    }

    assert.equal((await get(b1.id)).status, 'qa', 'no rejected request moved B');
    assert.equal((await get(b2.id)).status, 'qa', 'no rejected request moved B');
  });
});
