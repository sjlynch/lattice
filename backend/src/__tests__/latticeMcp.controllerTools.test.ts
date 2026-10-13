// Controller mode's own tools (`latticeMcp/tools/controllerTools.ts`, harness:
// helpers/latticeMcp.ts): `instances`, the merge-run pair, `export_board` and
// the `api_request` escape hatch. Pinned: a down instance is reported (and does
// not stall the listing on the restart-retry budget); `export_board` asks the
// list route for EVERY lane, full and unclipped, and writes the file without
// putting the board in the result; `api_request` cannot leave `/api/` (a
// `..`, an encoded `..` or a full URL would otherwise reach any route or host).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withTempDir } from './helpers/tempDir.js';
import { API, EXP, PROJECT, SANDBOX, connectController, isError, jsonOf, textOf, type Recorded } from './helpers/latticeMcp.js';

test('instances: reachability and known projects per instance, default marked', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(
    calls,
    ({ url }) => {
      if (url.origin === EXP) return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      if (url.pathname === '/api/health') return { body: { ok: true } };
      return { body: [{ path: PROJECT, hash: 'h1' }, { path: SANDBOX, hash: 'h2' }] };
    },
    // A real restart-retry budget: `instances` must not spend it on a down instance.
    { defaultProject: PROJECT, retryBudgetMs: 45_000 },
  );
  try {
    const rows = jsonOf(await client.callTool({ name: 'instances', arguments: {} }));
    assert.deepEqual(rows[0], {
      name: 'main', url: API, default: true, defaultProject: PROJECT, reachable: true, projects: [PROJECT, SANDBOX],
    });
    assert.equal(rows[1].name, 'exp');
    assert.equal(rows[1].reachable, false);
    assert.match(rows[1].error, /Could not reach the Lattice backend at http:\/\/127\.0\.0\.1:5484/);
    // No project is pinned on instance-level requests.
    assert.ok(calls.every((c) => !new URL(c.url).searchParams.has('project')));
    assert.equal(calls.filter((c) => c.url.startsWith(EXP)).length, 1, 'no restart retries for a down instance');
  } finally {
    await close();
  }
});

test('start_merge_run / get_merge_run: the merge routes, project pinned; no active run reads plainly', async () => {
  const calls: Recorded[] = [];
  const mergeRun = { id: 'mr_1', projectPath: SANDBOX, status: 'running', total: 2, processed: 0, merged: [], conflicted: [], errored: [] };
  const { client, close } = await connectController(calls, ({ url }) =>
    url.pathname.endsWith('/active') ? { body: null } : { body: mergeRun },
  );
  try {
    const started = jsonOf(await client.callTool({ name: 'start_merge_run', arguments: { instance: 'exp', project: SANDBOX } }));
    assert.equal(started.id, 'mr_1');
    const u0 = new URL(calls[0].url);
    assert.deepEqual([calls[0].method, u0.origin + u0.pathname, u0.searchParams.get('project')], ['POST', `${EXP}/api/merge-runs`, SANDBOX]);

    await client.callTool({ name: 'get_merge_run', arguments: { instance: 'exp', project: SANDBOX, id: 'mr_1' } });
    assert.equal(new URL(calls[1].url).pathname, '/api/merge-runs/mr_1');

    const none = await client.callTool({ name: 'get_merge_run', arguments: { instance: 'exp', project: SANDBOX } });
    assert.equal(new URL(calls[2].url).pathname, '/api/merge-runs/active');
    assert.equal(textOf(none), `No active merge run for ${SANDBOX}.`);
  } finally {
    await close();
  }
});

const BOARD = {
  project: SANDBOX,
  canonicalProject: SANDBOX,
  count: 3,
  tasks: [
    { id: 't1', status: 'done', description: 'D'.repeat(2000), projectPath: SANDBOX },
    { id: 't2', status: 'done', projectPath: SANDBOX },
    { id: 't3', status: 'deleted', projectPath: SANDBOX },
  ],
};

test('export_board writes every lane, full and unclipped, to outFile and returns only counts', () =>
  withTempDir('lattice-export-', async (dir) => {
    const calls: Recorded[] = [];
    const { client, close } = await connectController(calls, () => ({ body: BOARD }));
    try {
      const outFile = path.join(dir, 'nested', 'board.json');
      const r = await client.callTool({ name: 'export_board', arguments: { instance: 'exp', project: SANDBOX, outFile } });
      const q = new URL(calls[0].url).searchParams;
      assert.deepEqual(
        Object.fromEntries(q),
        { project: SANDBOX, status: 'all', fields: 'full', clip: '0', limit: '0', confirm_large: '1' },
      );
      const summary = jsonOf(r);
      assert.deepEqual({ ...summary, bytes: 0 }, { outFile, bytes: 0, count: 3, byStatus: { done: 2, deleted: 1 } });
      assert.ok(!textOf(r).includes('DDDD'), 'the board itself stays out of the result');
      const written = JSON.parse(await fs.readFile(outFile, 'utf8'));
      assert.equal(written.instance, EXP);
      assert.ok(written.exportedAt);
      assert.deepEqual(written.tasks, BOARD.tasks);

      const relative = await client.callTool({ name: 'export_board', arguments: { project: SANDBOX, outFile: 'board.json' } });
      assert.equal(isError(relative), true);
      assert.equal(calls.length, 1, 'a relative outFile is refused before any request');
    } finally {
      await close();
    }
  }));

test('export_board inline: no confirm_large unless asked, so a big board gets the 413 teaching result', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(calls, ({ url }) =>
    url.searchParams.has('confirm_large')
      ? { body: BOARD }
      : { status: 413, body: { error: 'response-too-large', suggestions: ['…'] } },
  );
  try {
    const big = await client.callTool({ name: 'export_board', arguments: { project: SANDBOX } });
    assert.equal(isError(big), false);
    assert.match(textOf(big), /response-too-large/);
    const forced = jsonOf(await client.callTool({ name: 'export_board', arguments: { project: SANDBOX, confirm_large: true } }));
    assert.equal(forced.tasks.length, 3);
  } finally {
    await close();
  }
});

test('api_request: any /api/ route on the chosen instance, no project added, status + body back', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(calls, ({ url }) =>
    url.pathname === '/api/settings' ? { body: { ok: true } } : { status: 404, body: { error: 'not found' } },
  );
  try {
    const r = await client.callTool({
      name: 'api_request',
      arguments: { instance: 'exp', method: 'PATCH', path: '/api/settings', query: { project: SANDBOX }, body: { a: 1 } },
    });
    assert.equal(textOf(r), 'HTTP 200\n{"ok":true}');
    assert.deepEqual([calls[0].method, calls[0].url, calls[0].body],
      ['PATCH', `${EXP}/api/settings?project=${encodeURIComponent(SANDBOX)}`, '{"a":1}']);

    const missing = await client.callTool({ name: 'api_request', arguments: { path: '/api/nope' } });
    assert.equal(isError(missing), true);
    assert.match(textOf(missing), /^HTTP 404\n/);
    assert.equal(calls[1].url, `${API}/api/nope`);
  } finally {
    await close();
  }
});

test('api_request refuses paths that leave /api/ — nothing is sent', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(calls, () => ({ body: {} }));
  try {
    for (const p of ['/health', 'api/tasks', '/api/../x', '/api/%2e%2e/x', '/api/tasks?project=x', 'http://evil/api/x', '//evil/api/x']) {
      const r = await client.callTool({ name: 'api_request', arguments: { path: p } });
      assert.equal(isError(r), true, p);
    }
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('api_request truncates a body over 64 KB with a note', async () => {
  const { client, close } = await connectController([], () => ({ body: 'x'.repeat(70 * 1024) }));
  try {
    const text = textOf(await client.callTool({ name: 'api_request', arguments: { path: '/api/big' } }));
    assert.ok(text.length < 66 * 1024);
    assert.match(text, /…\[truncated: first 65536 of 71680 bytes\]$/);
  } finally {
    await close();
  }
});
