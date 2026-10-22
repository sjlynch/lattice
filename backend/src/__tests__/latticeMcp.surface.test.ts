// Lattice's MCP server: the tool surface an agent gets (harness:
// helpers/latticeMcp.ts). The properties an agent gets burned by:
//   - the tool set is stable (11 tools, plus `my_task` ONLY when the session is a
//     task worktree's — a rename or a dropped registration is a silent
//     capability loss inside a running session),
//   - no tool accepts a `project` (it is pinned on every request), so an agent
//     cannot read or mutate the wrong board,
//   - a task worktree's agent gets no board-management tools and no
//     `opengrep_ignore` (a poisoned brief could otherwise hide the findings its
//     own change introduced),
//   - `append_summary`'s `id` is required in the schema without a session task
//     and defaults to that task with one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, connect, isError, textOf, type Recorded } from './helpers/latticeMcp.js';

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
  'opengrep_findings',
  'opengrep_ignore',
  'opengrep_scan',
  'plan_usage',
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
  'opengrep_findings',
  'opengrep_scan',
  'search_tasks',
];

test('a task-worktree session gets my_task and the read/file/report set — no board-management tools', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, undefined, { taskId: 't_mine' });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), WORKTREE_TOOLS);
    for (const absent of ['update_task', 'transition_tasks', 'delete_task', 'run_task', 'opengrep_ignore']) {
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

// `opengrep_ignore` writes the project's ignore lists permanently; a worktree
// brief is untrusted input, so only the read-only Opengrep tools reach a task
// agent (a poisoned brief could otherwise hide the findings its own change
// introduced from every later security review).
test('opengrep_ignore is offered outside a task worktree only; scan / findings are offered in both', async () => {
  const opengrepTools = async (taskId?: string) => {
    const { client, close } = await connect([], undefined, { taskId });
    try {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name).filter((n) => n.startsWith('opengrep_')).sort();
    } finally {
      await close();
    }
  };
  assert.deepEqual(await opengrepTools('t_mine'), ['opengrep_findings', 'opengrep_scan']);
  assert.deepEqual(await opengrepTools(undefined), ['opengrep_findings', 'opengrep_ignore', 'opengrep_scan']);
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
