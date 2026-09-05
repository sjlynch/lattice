// Lattice's own first-party MCP server (`../latticeMcp/`), driven end to end
// over the SDK's in-memory transport with a fake `fetchImpl` standing in for the
// backend. That combination is the point: it exercises the REAL tool registry,
// the real zod schemas and the real result shaping, while pinning the exact HTTP
// request each tool makes — which is the contract the routes are written to.
//
// The properties worth pinning here are the ones an agent gets burned by:
//   - the tool set is stable (11 tools, plus `my_task` ONLY when the session is a
//     task worktree's — a rename or a dropped registration is a silent
//     capability loss inside a running session),
//   - `project` is pinned on EVERY request and no tool accepts one, so an agent
//     cannot read or mutate the wrong board,
//   - `list_tasks` forwards ONLY what it was given — the API owns the defaults
//     ("compact, active lanes, newest 100"), and a default duplicated here would
//     drift from it silently,
//   - a 413 comes back as a NORMAL result (it is the teaching response; an
//     `isError` invites a retry of the same oversized call),
//   - and the two hard failures — a `canonicalProject` mismatch and an
//     unreachable backend — are errors that say which is which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLatticeMcpServer } from '../latticeMcp/createServer.js';
import type { FetchLike } from '../latticeMcp/client.js';

const PROJECT = 'C:\\development\\lattice';
const API = 'http://127.0.0.1:5184';

// Every request the fake fetch saw, in order.
type Recorded = { url: string; method: string; body: string | undefined };

type CannedResponse = { status?: number; body: unknown };

// A `fetchImpl` that records each call and answers with a canned envelope. The
// default envelope echoes `canonicalProject`, so the client's project assertion
// runs on the happy path too (a regression there would otherwise pass every
// test silently).
function fakeFetch(
  calls: Recorded[],
  canned: CannedResponse | (() => CannedResponse | Promise<never>) = {
    body: { canonicalProject: PROJECT, ok: true },
  },
): FetchLike {
  return async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const res = typeof canned === 'function' ? await canned() : canned;
    const status = res.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () =>
        typeof res.body === 'string' ? res.body : JSON.stringify(res.body),
    };
  };
}

// Wire a real server to a real client over the in-memory pair. Returns both plus
// the recorded-request array; the caller closes via the returned `close`.
async function connect(
  calls: Recorded[],
  canned?: CannedResponse | (() => CannedResponse | Promise<never>),
  // `taskId` makes this a task-worktree session (what LATTICE_TASK_ID does for
  // the real stdio entry): `my_task` appears and `append_summary` gains a default.
  opts: { taskId?: string } = {},
) {
  const server = createLatticeMcpServer({
    apiUrl: API,
    project: PROJECT,
    taskId: opts.taskId,
    fetchImpl: fakeFetch(calls, canned),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

// Narrow a CallToolResult's first text block.
function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const first = content[0];
  assert.equal(first?.type, 'text', 'result carries a text block');
  return first?.text ?? '';
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

// The 11 tools the contract fixes. Named explicitly (not counted) so a rename
// fails loudly rather than balancing out against a new registration.
const EXPECTED_TOOLS = [
  'append_summary',
  'board_summary',
  'create_task',
  'create_tasks',
  'delete_task',
  'get_task',
  'list_tasks',
  'run_task',
  'search_tasks',
  'transition_tasks',
  'update_task',
];

// ---- tool surface ----------------------------------------------------------

test('tools/list exposes exactly the 11 board tools, and none takes a project', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
    for (const tool of tools) {
      // `project` is pinned by the client from LATTICE_PROJECT; a tool that
      // accepted one would let an agent aim a write at another repo's board.
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      assert.ok(!('project' in props), `${tool.name} must not accept a project argument`);
      // The descriptions ARE the progressive-disclosure guidance — an empty one
      // means the model gets a bare name and no ladder.
      assert.ok((tool.description ?? '').length > 40, `${tool.name} needs a real description`);
    }
    // Outside a task worktree there is nothing for `append_summary` to default
    // to, so the SCHEMA must say `id` is required — the model reads the schema,
    // not the error message it would otherwise get.
    const append = tools.find((t) => t.name === 'append_summary')!;
    const required = (append.inputSchema as { required?: string[] }).required ?? [];
    assert.ok(required.includes('id'), 'id is required when the session has no task');
  } finally {
    await close();
  }
});

// ---- the task-worktree session (LATTICE_TASK_ID) -----------------------------

// The tool set a task worktree's agent gets: the reads, its own task, filing
// follow-ups, and reporting on itself. Board management (update / transition /
// delete / run) is deliberately absent — see createServer.ts.
const WORKTREE_TOOLS = [
  'append_summary',
  'board_summary',
  'create_task',
  'create_tasks',
  'get_task',
  'list_tasks',
  'my_task',
  'search_tasks',
];

test('a task-worktree session gets my_task and the read/file/report set — no board-management tools', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, undefined, { taskId: 't_mine' });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), WORKTREE_TOOLS);
    for (const absent of ['update_task', 'transition_tasks', 'delete_task', 'run_task']) {
      assert.ok(!tools.some((t) => t.name === absent), `${absent} must not reach a worktree agent`);
    }
    // …and `append_summary` drops `id` from its required list in this mode only
    // (the no-task variant is pinned in the tool-surface test above).
    const append = tools.find((t) => t.name === 'append_summary')!;
    const required = (append.inputSchema as { required?: string[] }).required ?? [];
    assert.ok(!required.includes('id'), 'id is optional in a task-worktree session');
    const myTask = tools.find((t) => t.name === 'my_task')!;
    // No arguments — the whole point is that the agent need not know its id.
    const props = (myTask.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.deepEqual(Object.keys(props), []);
    assert.ok(myTask.description?.includes('t_mine'), 'names the task it is bound to');

    await client.callTool({ name: 'my_task', arguments: {} });
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, `${API}/api/tasks/t_mine`);
    assert.equal(calls[0].method, 'GET');
  } finally {
    await close();
  }
});

test('append_summary without an id targets the session task when there is one, and errors when there is not', async () => {
  // With a task: the id is optional and defaults to it.
  const withTask: Recorded[] = [];
  const bound = await connect(withTask, undefined, { taskId: 't_mine' });
  try {
    const result = await bound.client.callTool({
      name: 'append_summary',
      arguments: { summary: 'did the thing' },
    });
    assert.equal(isError(result), false);
    const url = new URL(withTask[0].url);
    assert.equal(url.pathname, '/api/tasks/t_mine/append-summary');
    assert.equal(withTask[0].method, 'POST');
    assert.deepEqual(JSON.parse(withTask[0].body ?? '{}'), { summary: 'did the thing' });

    // An explicit id still wins over the default.
    await bound.client.callTool({
      name: 'append_summary',
      arguments: { id: 't_other', summary: 'x' },
    });
    assert.equal(new URL(withTask[1].url).pathname, '/api/tasks/t_other/append-summary');
  } finally {
    await bound.close();
  }

  // Without a task: no default exists, so `id` is REQUIRED in the schema and the
  // SDK rejects an id-less call at validation — before the handler, and before
  // any HTTP request (guessing a target would be a write to the wrong task).
  // The handler's own "needs an id" guard sits behind this as a backstop.
  const noTask: Recorded[] = [];
  const unbound = await connect(noTask);
  try {
    const result = await unbound.client.callTool({
      name: 'append_summary',
      arguments: { summary: 'did the thing' },
    });
    assert.equal(isError(result), true);
    assert.match(textOf(result), /Invalid arguments for tool append_summary.*\bid\b/);
    assert.equal(noTask.length, 0, 'no request was made');
  } finally {
    await unbound.close();
  }
});

// ---- reads -----------------------------------------------------------------

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

// ---- writes ----------------------------------------------------------------

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

// ---- failure shapes --------------------------------------------------------

test('a 413 comes back as a NORMAL result carrying the summary + suggestions', async () => {
  // The response-size ceiling is a TEACHING response: the agent has to read the
  // summary and the narrowing suggestions. Flagging it isError would push the
  // model to retry the identical oversized call instead.
  const oversize = {
    error: 'response-too-large',
    bytes: 1276099,
    approxTokens: 319025,
    ceilingBytes: 262144,
    summary: { total: 479, byStatus: { done: 469 } },
    suggestions: [
      'GET /api/tasks/summary?project=… — counts + per-lane cost (under 1 KB)',
      'add limit=50 (newest first) or since=30d',
    ],
    hint: 'This response would be ~319025 tokens. Narrow it, or confirm_large=1.',
  };
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, { status: 413, body: oversize });
  try {
    const result = await client.callTool({ name: 'list_tasks', arguments: {} });
    assert.equal(isError(result), false, '413 must not be an error result');
    const payload = JSON.parse(textOf(result));
    assert.equal(payload.error, 'response-too-large');
    assert.ok(Array.isArray(payload.suggestions) && payload.suggestions.length > 0);
    assert.ok(payload.summary, 'the board summary rides along');
  } finally {
    await close();
  }
});

test('a canonicalProject mismatch is an error naming both projects', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, {
    body: { canonicalProject: 'D:\\other\\repo', count: 3 },
  });
  try {
    const result = await client.callTool({ name: 'list_tasks', arguments: {} });
    assert.equal(isError(result), true);
    const text = textOf(result);
    assert.match(text, /mismatch/i);
    assert.ok(text.includes(PROJECT), 'names the pinned project');
    assert.ok(text.includes('D:\\other\\repo'), 'names the project the backend answered for');
  } finally {
    await close();
  }
});

test('a bare Task from another project is a mismatch too (by-id routes echo projectPath, not canonicalProject)', async () => {
  // Every by-id route returns a bare Task with no `canonicalProject`. If the
  // client only checked that field, get_task / update_task / delete_task /
  // run_task / append_summary would be entirely unpinned — an id copied from
  // another board's doc would read or mutate that board silently. (The server
  // also 404s these by `?project=`; this is the response-side backstop.)
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, {
    body: { id: 't_x', projectPath: 'C:\\other\\repo', title: 'x', status: 'open', createdAt: 1 },
  });
  try {
    const result = await client.callTool({ name: 'get_task', arguments: { id: 't_x' } });
    assert.equal(isError(result), true);
    assert.match(textOf(result), /Project mismatch/);
    assert.match(textOf(result), /C:\\other\\repo/);
    // …and the request itself carried the pin the server enforces.
    assert.equal(new URL(calls[0].url).searchParams.get('project'), PROJECT);
  } finally {
    await close();
  }
});

test('a case-only / separator-only difference is NOT a project mismatch', async () => {
  // Windows paths are case-insensitive but only case-preserving, so `c:\x` and
  // `C:\x` are the same board. A false alarm here would break every tool call.
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, {
    body: { canonicalProject: 'c:/development/lattice/' },
  });
  try {
    const result = await client.callTool({ name: 'board_summary', arguments: {} });
    assert.equal(isError(result), false);
  } finally {
    await close();
  }
});

test('an unreachable backend is an error naming the URL and asking if Lattice is running', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, () => {
    return Promise.reject(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5184'), { code: 'ECONNREFUSED' }),
    );
  });
  try {
    const result = await client.callTool({ name: 'board_summary', arguments: {} });
    assert.equal(isError(result), true);
    const text = textOf(result);
    assert.ok(text.includes(API), 'names the API URL it tried');
    assert.match(text, /Is Lattice running\?/);
  } finally {
    await close();
  }
});

test('any other non-2xx is an error carrying the status and the body', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, {
    status: 400,
    body: { error: 'title required (must be a non-empty string)' },
  });
  try {
    const result = await client.callTool({ name: 'create_task', arguments: { title: 'x' } });
    assert.equal(isError(result), true);
    const text = textOf(result);
    assert.match(text, /HTTP 400/);
    assert.match(text, /title required/);
  } finally {
    await close();
  }
});
