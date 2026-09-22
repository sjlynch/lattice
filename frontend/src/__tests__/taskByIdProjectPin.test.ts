import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abortTaskMerge,
  cancelQueuedRun,
  deleteTask,
  mergeTask,
  resumeTask,
  runTask,
  taskByIdUrl,
  updateTask,
} from '../api/tasks';

// The backend's by-id task routes look the id up GLOBALLY across every indexed
// project, and only refuse a task from another board (404, via
// `requireTaskInRequestedProject`) when the caller sends `?project=`. The board
// UI must therefore pin every by-id call to the active project — drop the param
// in a refactor and a stale id silently mutates a foreign board again.

const PROJECT = 'C:\\dev\\my proj&x';

async function captureRequests(fn: () => Promise<unknown>) {
  const g = globalThis as { fetch: typeof fetch };
  const original = g.fetch;
  const calls: { url: string; method: string }[] = [];
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    g.fetch = original;
  }
  return calls;
}

function parse(url: string) {
  return new URL(url, 'http://placeholder');
}

test('every by-id task call carries the active project as ?project=', async () => {
  const cases: [string, string, () => Promise<unknown>][] = [
    ['PATCH', '/api/tasks/t%2F1', () => updateTask(PROJECT, 't/1', { title: 'x' })],
    ['DELETE', '/api/tasks/t%2F1', () => deleteTask(PROJECT, 't/1')],
    ['POST', '/api/tasks/t%2F1/run', () => runTask(PROJECT, 't/1', 'claude')],
    ['POST', '/api/tasks/t%2F1/resume', () => resumeTask(PROJECT, 't/1')],
    ['POST', '/api/tasks/t%2F1/cancel-queued-run', () => cancelQueuedRun(PROJECT, 't/1')],
    ['POST', '/api/tasks/t%2F1/merge', () => mergeTask(PROJECT, 't/1')],
    ['POST', '/api/tasks/t%2F1/merge-aborted', () => abortTaskMerge(PROJECT, 't/1')],
  ];
  for (const [method, pathname, call] of cases) {
    const calls = await captureRequests(call);
    assert.equal(calls.length, 1, pathname);
    assert.equal(calls[0].method, method, pathname);
    const url = parse(calls[0].url);
    assert.equal(url.pathname, pathname);
    assert.equal(url.searchParams.get('project'), PROJECT, `${pathname} is project-pinned`);
    assert.equal([...url.searchParams.keys()].length, 1, `${pathname} has only the project param`);
  }
});

test('run/resume keep their JSON body alongside the project query', async () => {
  const g = globalThis as { fetch: typeof fetch };
  const original = g.fetch;
  let body = '';
  g.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = String(init?.body ?? '');
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
  try {
    await runTask(PROJECT, 't1', 'pi', 'prov/model');
  } finally {
    g.fetch = original;
  }
  assert.deepEqual(JSON.parse(body), { harness: 'pi', piModel: 'prov/model' });
});

test('an empty project omits the param (backend treats it as unpinned)', () => {
  assert.equal(taskByIdUrl('', 'abc', '/run'), '/api/tasks/abc/run');
  assert.equal(
    taskByIdUrl('/p', 'abc'),
    `/api/tasks/abc?project=${encodeURIComponent('/p')}`,
  );
});

test('a foreign-board 404 rejects like any other failure', async () => {
  const g = globalThis as { fetch: typeof fetch };
  const original = g.fetch;
  g.fetch = (async () =>
    ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not found', hint: 'different board' }),
    }) as unknown as Response) as typeof fetch;
  try {
    await assert.rejects(runTask(PROJECT, 't1'), (err: Error & { status?: number }) => {
      assert.equal(err.status, 404);
      assert.equal(err.message, 'not found');
      return true;
    });
  } finally {
    g.fetch = original;
  }
});
