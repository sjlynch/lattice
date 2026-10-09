// Lattice's MCP server: failure shapes (harness: helpers/latticeMcp.ts).
//   - a 413 comes back as a NORMAL result (it is the teaching response; an
//     `isError` invites a retry of the same oversized call),
//   - the two hard failures — a `canonicalProject` mismatch (a bare Task from
//     another project included; a case/separator-only difference is not one)
//     and an unreachable backend — are errors that say which is which,
//   - a restarting backend (connection refused, then 503) is retried until it
//     answers, within a budget; a POST is never re-sent after an ambiguous
//     network error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, PROJECT, connect, isError, textOf, type Recorded } from './helpers/latticeMcp.js';

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

// Restart retry (LatticeClient.send): when Lattice works on its own repo the
// backend restarts after merges, and a board call in that window used to fail
// with "Is Lattice running?" — which tells the agent to stop using the board.
test('a backend that is restarting (connection refused, then 503) is retried until it answers', async () => {
  const { LatticeClient } = await import('../latticeMcp/client.js');
  const answers: (() => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>)[] = [
    () => Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
    () => Promise.resolve({ ok: false, status: 503, text: async () => '{"code":"backend-restarting"}' }),
    () => Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ canonicalProject: PROJECT, id: 't1' }) }),
  ];
  const methods: string[] = [];
  const slept: number[] = [];
  const client = new LatticeClient({
    apiUrl: API,
    project: PROJECT,
    fetchImpl: (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return answers.shift()!();
    },
    retry: { budgetMs: 10_000, sleep: async (ms) => void slept.push(ms) },
  });
  // A POST: ECONNREFUSED and 503 both mean "never acted on", so it is safe to resend.
  const outcome = await client.call('/api/tasks', { method: 'POST', body: { title: 'x' } });
  assert.equal(outcome.kind, 'ok');
  assert.deepEqual(methods, ['POST', 'POST', 'POST']);
  assert.equal(slept.length, 2);
});

test('a POST is not re-sent after an ambiguous network error, and the budget bounds the wait', async () => {
  const { LatticeClient } = await import('../latticeMcp/client.js');
  let calls = 0;
  const reset = new LatticeClient({
    apiUrl: API,
    project: PROJECT,
    fetchImpl: () => {
      calls++;
      return Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    },
    retry: { budgetMs: 10_000, sleep: async () => {} },
  });
  assert.equal((await reset.call('/api/tasks', { method: 'POST', body: {} })).kind, 'unreachable');
  assert.equal(calls, 1, 'the request may have been acted on — never duplicate a create');

  let slept = 0;
  const down = new LatticeClient({
    apiUrl: API,
    project: PROJECT,
    fetchImpl: () => Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
    retry: { budgetMs: 3_000, sleep: async (ms) => void (slept += ms) },
  });
  assert.equal((await down.call('/api/tasks/summary')).kind, 'unreachable');
  assert.equal(slept, 3_000, 'gives up exactly at the budget');
});
