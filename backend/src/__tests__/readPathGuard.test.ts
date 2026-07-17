import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import { canonicalProjectPath } from '../projectPath.js';
import { requireAbsoluteProject } from '../routes/tasks/requestUtils.js';
import { TaskCacheManager } from '../taskCache/manager.js';

// Minimal Response stand-in that records the status/json a handler would send.
function fakeRes(): Response & { _status?: number; _body?: unknown } {
  const r = {
    status(code: number) {
      (r as { _status?: number })._status = code;
      return r;
    },
    json(body: unknown) {
      (r as { _body?: unknown })._body = body;
      return r;
    },
  } as unknown as Response & { _status?: number; _body?: unknown };
  return r;
}

// ---------- Layer 1: loud route guard ----------

test('requireAbsoluteProject: a relative project is rejected with a 400', () => {
  const res = fakeRes();
  const ok = requireAbsoluteProject('developmentlesser_evil', res);
  assert.equal(ok, false);
  assert.equal(res._status, 400);
  assert.match((res._body as { error: string }).error, /absolute path/);
});

test('requireAbsoluteProject: an absolute project passes without responding', () => {
  const res = fakeRes();
  const ok = requireAbsoluteProject(canonicalProjectPath(process.cwd()), res);
  assert.equal(ok, true);
  assert.equal(res._status, undefined, 'must not touch the response on the happy path');
});

// ---------- Layer 2: index-registration chokepoint ----------

test('listTasks does NOT register a non-absolute project in the index', async () => {
  const store = new TaskCacheManager();
  const relative = 'some-relative-project-xyz-readpath';
  const resolved = canonicalProjectPath(relative); // path.resolve → cwd/…, absolute
  const tasks = await store.listTasks(relative);
  assert.deepEqual(tasks, [], 'a bogus project has no tasks');
  assert.equal(
    store.projectsIndex.list().includes(resolved),
    false,
    'a non-absolute project queried on the read path must never be indexed',
  );
});

test('listTasks DOES register an absolute project (normal behavior preserved)', async () => {
  const store = new TaskCacheManager();
  const abs = canonicalProjectPath(process.cwd());
  await store.listTasks(abs);
  assert.equal(
    store.projectsIndex.list().includes(abs),
    true,
    'an absolute project read still registers, as before',
  );
});
