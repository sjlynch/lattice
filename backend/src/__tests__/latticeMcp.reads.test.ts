// Lattice's MCP server: the requests the read tools make (harness:
// helpers/latticeMcp.ts). `project` is pinned on EVERY request, and
// `list_tasks` forwards ONLY what it was given — the API owns the defaults
// ("compact, active lanes, newest 100"), and a default duplicated here would
// drift from it silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, PROJECT, connect, isError, textOf, type Recorded } from './helpers/latticeMcp.js';

test('board_summary GETs /api/tasks/summary with the pinned project', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    const result = await client.callTool({ name: 'board_summary', arguments: {} });
    assert.equal(isError(result), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, `${API}/api/tasks/summary`);
    assert.equal(url.searchParams.get('project'), PROJECT);
    // The envelope comes back compact, as JSON text.
    assert.deepEqual(JSON.parse(textOf(result)), { canonicalProject: PROJECT, ok: true });
  } finally {
    await close();
  }
});

test('list_tasks forwards ONLY the args it was given (the API owns the defaults)', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    // No args at all → nothing but `project`. If this tool invented
    // `fields=compact&limit=100` client-side it would silently freeze today's
    // API defaults into the MCP layer.
    await client.callTool({ name: 'list_tasks', arguments: {} });
    const bare = new URL(calls[0].url);
    assert.deepEqual([...bare.searchParams.keys()], ['project']);
    assert.equal(bare.origin + bare.pathname, `${API}/api/tasks`);

    await client.callTool({
      name: 'list_tasks',
      arguments: { status: 'done', since: '30d', limit: 25, fields: 'full', clip: 0 },
    });
    const full = new URL(calls[1].url);
    assert.equal(full.searchParams.get('status'), 'done');
    assert.equal(full.searchParams.get('since'), '30d');
    assert.equal(full.searchParams.get('limit'), '25');
    assert.equal(full.searchParams.get('fields'), 'full');
    // `clip: 0` means "unlimited" — a falsy-drop would turn it into the 500-char
    // default and quietly truncate the text the agent asked for in full.
    assert.equal(full.searchParams.get('clip'), '0');

    // `ids` is an array on the tool, CSV on the wire.
    await client.callTool({ name: 'list_tasks', arguments: { ids: ['t_a', 't_b'] } });
    assert.equal(new URL(calls[2].url).searchParams.get('ids'), 't_a,t_b');

    // `confirm_large` is the only way past the API's 256 KB ceiling — without it
    // the 413 teaching response is a dead end for an MCP-only agent. A boolean on
    // the tool, `1` on the wire; `false` sends nothing rather than `0`.
    await client.callTool({ name: 'list_tasks', arguments: { confirm_large: true } });
    assert.equal(new URL(calls[3].url).searchParams.get('confirm_large'), '1');
    await client.callTool({ name: 'list_tasks', arguments: { confirm_large: false } });
    assert.equal(new URL(calls[4].url).searchParams.has('confirm_large'), false);
  } finally {
    await close();
  }
});

test('search_tasks GETs /api/tasks/search with q + optional filters', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    await client.callTool({
      name: 'search_tasks',
      arguments: { q: 'merge conflict', status: 'all', limit: 5 },
    });
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, `${API}/api/tasks/search`);
    assert.equal(url.searchParams.get('q'), 'merge conflict');
    assert.equal(url.searchParams.get('status'), 'all');
    assert.equal(url.searchParams.get('limit'), '5');
    assert.equal(url.searchParams.get('project'), PROJECT);
  } finally {
    await close();
  }
});

test('get_task GETs /api/tasks/:id and url-encodes the id', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    await client.callTool({ name: 'get_task', arguments: { id: 't 1/x' } });
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/api/tasks/t%201%2Fx');
  } finally {
    await close();
  }
});
