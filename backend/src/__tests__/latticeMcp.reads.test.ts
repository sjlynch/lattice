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

// plan_usage is machine-wide: it reads GET /api/plan-usage (the pinned project
// rides along and is ignored), forwards refresh only when asked, and is not
// offered to a task-worktree session.
test('plan_usage GETs /api/plan-usage, refresh only on request; absent in task worktrees', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    await client.callTool({ name: 'plan_usage', arguments: {} });
    const bare = new URL(calls[0].url);
    assert.equal(bare.origin + bare.pathname, `${API}/api/plan-usage`);
    assert.equal(bare.searchParams.get('refresh'), null);
    await client.callTool({ name: 'plan_usage', arguments: { refresh: true } });
    assert.equal(new URL(calls[1].url).searchParams.get('refresh'), '1');
  } finally {
    await close();
  }
  const worktree = await connect([], undefined, { taskId: 't_mine' });
  try {
    const { tools } = await worktree.client.listTools();
    assert.ok(!tools.some((t) => t.name === 'plan_usage'));
  } finally {
    await worktree.close();
  }
});

// Fleet tools exist only in a session the user started (LATTICE_FLEET=1) and
// reach the machine-wide routes: the overview, an agent launch (targetProject
// → project), and a terminal's screen / input / wait by pty id.
test('fleet tools: only with fleet on; each hits its route', async () => {
  const plain = await connect([]);
  try {
    const { tools } = await plain.client.listTools();
    assert.ok(!tools.some((t) => ['fleet', 'open_agent', 'read_terminal', 'send_terminal', 'wait_terminal'].includes(t.name)));
  } finally {
    await plain.close();
  }
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, undefined, { fleet: true });
  try {
    await client.callTool({ name: 'fleet', arguments: { since: 7 } });
    await client.callTool({ name: 'open_agent', arguments: { targetProject: 'C:\other', harness: 'codex', prompt: 'do it' } });
    await client.callTool({ name: 'read_terminal', arguments: { id: 'p 1', lines: 50 } });
    await client.callTool({ name: 'send_terminal', arguments: { id: 'p1', text: 'yes', submit: true } });
    await client.callTool({ name: 'wait_terminal', arguments: { id: 'p1' } });
    const urls = calls.map((c) => { const u = new URL(c.url); return `${c.method} ${u.pathname}`; });
    assert.deepEqual(urls, [
      'GET /api/fleet',
      'POST /api/fleet/agents',
      'GET /api/terminals/p%201/screen',
      'POST /api/terminals/p1/input',
      'POST /api/terminals/p1/wait-idle',
    ]);
    assert.equal(new URL(calls[0].url).searchParams.get('since'), '7');
    assert.deepEqual(JSON.parse(String(calls[1].body)), { project: 'C:\other', harness: 'codex', prompt: 'do it' });
    assert.deepEqual(JSON.parse(String(calls[3].body)), { text: 'yes', submit: true });
    assert.deepEqual(JSON.parse(String(calls[4].body)), { timeoutMs: 50000 });
  } finally {
    await close();
  }
});
