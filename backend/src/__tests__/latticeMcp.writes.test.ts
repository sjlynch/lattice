// Lattice's MCP server: the requests the write tools make (harness:
// helpers/latticeMcp.ts) — the exact method, path and JSON body, which is the
// contract the routes are written to. A PATCH carries only the given fields;
// Windows paths, literal escapes and control characters survive
// `append_summary`; `delete_task` leads its result with the kept-branch hint
// when the branch was kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, isError, textOf, type Recorded } from './helpers/latticeMcp.js';

test('create_tasks POSTs the batch endpoint with a JSON {tasks} body', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    await client.callTool({
      name: 'create_tasks',
      arguments: { tasks: [{ title: 'one' }, { title: 'two', description: 'body' }] },
    });
    assert.equal(calls[0].method, 'POST');
    assert.equal(new URL(calls[0].url).pathname, '/api/tasks/batch');
    assert.deepEqual(JSON.parse(calls[0].body ?? ''), {
      tasks: [{ title: 'one' }, { title: 'two', description: 'body' }],
    });
  } finally {
    await close();
  }
});

test('create_task POSTs /api/tasks with title + description', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    await client.callTool({ name: 'create_task', arguments: { title: 'a', description: 'd' } });
    assert.equal(calls[0].method, 'POST');
    assert.equal(new URL(calls[0].url).pathname, '/api/tasks');
    assert.deepEqual(JSON.parse(calls[0].body ?? ''), { title: 'a', description: 'd' });
  } finally {
    await close();
  }
});

test('transition_tasks POSTs /api/tasks/transition with ids or fromStatus', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    await client.callTool({
      name: 'transition_tasks',
      arguments: { ids: ['a', 'b'], status: 'done' },
    });
    assert.equal(calls[0].method, 'POST');
    assert.equal(new URL(calls[0].url).pathname, '/api/tasks/transition');
    assert.deepEqual(JSON.parse(calls[0].body ?? ''), { status: 'done', ids: ['a', 'b'] });

    // Lane-wide form: no `ids` key at all (the route branches on its absence).
    await client.callTool({
      name: 'transition_tasks',
      arguments: { fromStatus: 'qa', status: 'done' },
    });
    assert.deepEqual(JSON.parse(calls[1].body ?? ''), { status: 'done', fromStatus: 'qa' });
  } finally {
    await close();
  }
});

test('update_task PATCHes only the fields it was given', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    await client.callTool({ name: 'update_task', arguments: { id: 't1', status: 'qa' } });
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(new URL(calls[0].url).pathname, '/api/tasks/t1');
    // No `title: undefined` / `description: undefined` — a PATCH that carries
    // an explicit undefined title is a different request from one that omits it.
    assert.deepEqual(JSON.parse(calls[0].body ?? ''), { status: 'qa' });
  } finally {
    await close();
  }
});

test('append_summary POSTs /api/tasks/:id/append-summary', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    await client.callTool({
      name: 'append_summary',
      arguments: { id: 't1', summary: '## Done\nall good' },
    });
    assert.equal(calls[0].method, 'POST');
    assert.equal(new URL(calls[0].url).pathname, '/api/tasks/t1/append-summary');
    assert.deepEqual(JSON.parse(calls[0].body ?? ''), { summary: '## Done\nall good' });
  } finally {
    await close();
  }
});

test('append_summary serializes Windows paths, literal escapes, quotes, and control characters', async () => {
  const summary = [
    String.raw`- Fixed C:\development\lattice\backend and C:\new\test.txt`,
    String.raw`- Regex: \d+\s+ and markdown \[brackets\]`,
    '- Says "done"; keeps \\n as text beside an actual tab:\tand Unicode: ✓',
  ].join('\r\n');
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, undefined, { taskId: 't_mine' });
  try {
    const result = await client.callTool({ name: 'append_summary', arguments: { summary } });
    assert.equal(isError(result), false);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).pathname, '/api/tasks/t_mine/append-summary');
    assert.deepEqual(JSON.parse(calls[0].body ?? ''), { summary });
  } finally {
    await close();
  }
});

test('delete_task DELETEs /api/tasks/:id', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    await client.callTool({ name: 'delete_task', arguments: { id: 't1' } });
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(new URL(calls[0].url).pathname, '/api/tasks/t1');
  } finally {
    await close();
  }
});

test('delete_task leads its result with the kept-branch hint when the branch was kept', async () => {
  const hint = 'kept branch lattice/foo-ab12: 3 unmerged commit(s). Merge it, or run ' +
    '`git branch -D lattice/foo-ab12` to discard.';
  const body = { ok: true, keptBranch: { name: 'lattice/foo-ab12', unmergedCommits: 3, hint } };
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, { body });
  try {
    const result = await client.callTool({ name: 'delete_task', arguments: { id: 't1' } });
    assert.equal(isError(result), false);
    const text = textOf(result);
    assert.ok(text.startsWith(hint + '\n'), text);
    assert.deepEqual(JSON.parse(text.slice(hint.length + 1)), body, 'the JSON still follows');
  } finally {
    await close();
  }
});

test('delete_task result is plain JSON when no branch was kept', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, { body: { ok: true } });
  try {
    const result = await client.callTool({ name: 'delete_task', arguments: { id: 't1' } });
    assert.deepEqual(JSON.parse(textOf(result)), { ok: true });
  } finally {
    await close();
  }
});

test('run_task POSTs /api/tasks/:id/run and carries harness + piModel', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, {
    body: { accepted: true, queued: true },
  });
  try {
    const result = await client.callTool({
      name: 'run_task',
      arguments: { id: 't1', harness: 'pi', piModel: 'anthropic/claude' },
    });
    assert.equal(calls[0].method, 'POST');
    assert.equal(new URL(calls[0].url).pathname, '/api/tasks/t1/run');
    assert.deepEqual(JSON.parse(calls[0].body ?? ''), {
      harness: 'pi',
      piModel: 'anthropic/claude',
    });
    // The response has no canonicalProject — the assertion must not fire on an
    // envelope that simply doesn't carry one.
    assert.equal(isError(result), false);
    assert.deepEqual(JSON.parse(textOf(result)), { accepted: true, queued: true });

    // Bare form omits both optional fields entirely.
    await client.callTool({ name: 'run_task', arguments: { id: 't2' } });
    assert.deepEqual(JSON.parse(calls[1].body ?? ''), {});
  } finally {
    await close();
  }
});
