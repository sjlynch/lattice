// Controller mode of Lattice's MCP server (`latticeMcp/createControllerServer.ts`,
// harness: helpers/latticeMcp.ts): instance parsing, the tool surface, and the
// per-call routing that replaces the pinned server's env pin. What must hold:
//   - the pinned server is unchanged — same tools, no `instance`/`project`
//     argument anywhere, `run_task` without the controller's model fields;
//   - every scoped controller tool takes `instance` + `project` and each call
//     goes to THAT instance with THAT project (`project=` on every request);
//   - LATTICE_PROJECT is a default for the default instance ONLY — a forgotten
//     `project` on another instance must not aim it at the session's own board;
//   - responses are still checked against the requested project, and an
//     `instance` is a configured name or a LOOPBACK URL, never any host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstanceConfig, resolveInstance } from '../latticeMcp/instances.js';
import {
  API,
  EXP,
  PROJECT,
  SANDBOX,
  connect,
  connectController,
  isError,
  jsonOf,
  textOf,
  type Recorded,
} from './helpers/latticeMcp.js';

const CONTROLLER_TOOLS = [
  'api_request', 'board_summary', 'cancel_workflow_run', 'create_tasks', 'delete_task',
  'delete_workflow', 'export_board', 'find_pcs', 'fleet', 'fleet_create_task', 'fleet_merge',
  'fleet_tasks', 'get_merge_run', 'get_task',
  'get_workflow', 'get_workflow_run', 'instances', 'list_tasks', 'list_workflow_runs',
  'list_workflows', 'open_agent', 'plan_usage', 'read_terminal', 'run_task',
  'save_workflow', 'search_tasks', 'send_terminal', 'start_merge_run', 'start_workflow_run',
  'transition_tasks', 'update_task', 'wait_terminal', 'wait_workflow_run',
];

// Machine-level tools: `instance`, never `project` (fleet tools name a
// `targetProject` where they need one).
const INSTANCE_ONLY = new Set(['api_request', 'plan_usage', 'fleet', 'open_agent', 'read_terminal', 'send_terminal', 'wait_terminal', 'fleet_tasks', 'fleet_create_task', 'fleet_merge', 'find_pcs']);

const props = (tool: { inputSchema: unknown }) =>
  Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});

// ---- instance config ----------------------------------------------------------

test('parseInstanceConfig: list and JSON forms, LATTICE_API_URL first, and the fallback', () => {
  const list = parseInstanceConfig({ LATTICE_INSTANCES: 'main=http://localhost:5184/, exp=http://localhost:5484' });
  assert.deepEqual(list, {
    config: { instances: [{ name: 'main', url: 'http://localhost:5184' }, { name: 'exp', url: 'http://localhost:5484' }] },
  });
  const json = parseInstanceConfig({ LATTICE_INSTANCES: '{"a":"http://127.0.0.1:1","b":"https://h.example/x/"}' });
  assert.deepEqual(json, {
    config: { instances: [{ name: 'a', url: 'http://127.0.0.1:1' }, { name: 'b', url: 'https://h.example/x' }] },
  });
  // A bare URL is named after its port.
  assert.deepEqual(parseInstanceConfig({ LATTICE_INSTANCES: 'http://localhost:5484' }), {
    config: { instances: [{ name: '5484', url: 'http://localhost:5484' }] },
  });
  // LATTICE_API_URL is the default (first): the matching entry moves up, keeping its name…
  const moved = parseInstanceConfig({ LATTICE_INSTANCES: 'exp=http://localhost:5484,main=http://localhost:5184', LATTICE_API_URL: 'http://localhost:5184' });
  assert.deepEqual('config' in moved && moved.config.instances.map((i) => i.name), ['main', 'exp']);
  // …else it is prepended as `default`, with LATTICE_PROJECT as the default project.
  const pre = parseInstanceConfig({ LATTICE_INSTANCES: 'exp=http://localhost:5484', LATTICE_API_URL: 'http://127.0.0.1:5184', LATTICE_PROJECT: ' C:\\p ' });
  assert.deepEqual(pre, {
    config: {
      instances: [{ name: 'default', url: 'http://127.0.0.1:5184' }, { name: 'exp', url: 'http://localhost:5484' }],
      defaultProject: 'C:\\p',
    },
  });
  assert.deepEqual(parseInstanceConfig({}), { config: { instances: [{ name: 'default', url: 'http://localhost:5184' }] } });
});

test('parseInstanceConfig: malformed config is a startup error, never a silent guess', () => {
  for (const env of [
    { LATTICE_INSTANCES: '{"a":' },
    { LATTICE_INSTANCES: '["http://x"]' },
    { LATTICE_INSTANCES: 'a=ftp://x' },
    { LATTICE_INSTANCES: 'a=http://x,A=http://y' },
    { LATTICE_INSTANCES: 'bad name=http://x' },
    { LATTICE_INSTANCES: 'default=http://localhost:1', LATTICE_API_URL: 'http://localhost:2' },
    { LATTICE_API_URL: 'not a url' },
  ]) {
    assert.ok('error' in parseInstanceConfig(env), JSON.stringify(env));
  }
});

test('resolveInstance: default, name (any case), configured URL, loopback URL; other hosts refused', () => {
  const config = { instances: [{ name: 'main', url: API }, { name: 'exp', url: EXP }] };
  assert.equal(resolveInstance(config, undefined)?.name, 'main');
  assert.equal(resolveInstance(config, 'EXP')?.name, 'exp');
  assert.equal(resolveInstance(config, `${EXP}/`)?.name, 'exp');
  assert.deepEqual(resolveInstance(config, 'http://localhost:5584'), { name: 'http://localhost:5584', url: 'http://localhost:5584' });
  assert.equal(resolveInstance(config, 'http://[::1]:5584')?.url, 'http://[::1]:5584');
  assert.equal(resolveInstance(config, 'https://lattice.example.com'), null);
  assert.equal(resolveInstance(config, 'nope'), null);
});

// ---- surface -----------------------------------------------------------------

test('controller tools/list: the fixed set; every scoped tool takes instance + project', async () => {
  const { client, close } = await connectController([], () => ({ body: {} }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), CONTROLLER_TOOLS);
    for (const tool of tools) {
      assert.ok((tool.description ?? '').length > 40, `${tool.name} needs a real description`);
      const p = props(tool);
      if (tool.name === 'instances') assert.deepEqual(p, []);
      else if (INSTANCE_ONLY.has(tool.name)) assert.ok(p.includes('instance') && !p.includes('project'), `${tool.name}: ${p}`);
      else assert.ok(p.includes('instance') && p.includes('project'), `${tool.name}: ${p}`);
    }
    const run = tools.find((t) => t.name === 'run_task')!;
    assert.deepEqual(props(run).sort(), ['effort', 'harness', 'id', 'instance', 'model', 'piModel', 'project']);
  } finally {
    await close();
  }
});

test('the pinned server is unchanged: no instance/project anywhere, run_task without model fields', async () => {
  const { client, close } = await connect([]);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 15);
    for (const tool of tools) {
      assert.ok(!props(tool).some((p) => p === 'instance' || p === 'project'), tool.name);
    }
    assert.deepEqual(props(tools.find((t) => t.name === 'run_task')!).sort(), ['harness', 'id', 'piModel']);
    assert.ok(!tools.some((t) => CONTROLLER_TOOLS.includes(t.name) && /workflow|merge|export|instances|api_request/.test(t.name)));
  } finally {
    await close();
  }
});

// ---- routing -----------------------------------------------------------------

test('each call goes to the named instance with the named project', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(calls, ({ url }) => ({
    body: { canonicalProject: url.searchParams.get('project'), counts: {} },
  }));
  try {
    await client.callTool({ name: 'board_summary', arguments: { instance: 'exp', project: SANDBOX } });
    await client.callTool({ name: 'board_summary', arguments: { project: PROJECT } });
    await client.callTool({ name: 'board_summary', arguments: { instance: 'http://localhost:5584', project: SANDBOX } });
    const urls = calls.map((c) => new URL(c.url));
    assert.deepEqual(urls.map((u) => u.origin + u.pathname), [
      `${EXP}/api/tasks/summary`,
      `${API}/api/tasks/summary`,
      'http://localhost:5584/api/tasks/summary',
    ]);
    assert.deepEqual(urls.map((u) => u.searchParams.get('project')), [SANDBOX, PROJECT, SANDBOX]);
  } finally {
    await close();
  }
});

test('LATTICE_PROJECT defaults the project on the default instance only', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(
    calls,
    () => ({ body: { canonicalProject: PROJECT } }),
    { defaultProject: PROJECT },
  );
  try {
    const ok = await client.callTool({ name: 'list_tasks', arguments: {} });
    assert.equal(isError(ok), false);
    assert.equal(new URL(calls[0].url).searchParams.get('project'), PROJECT);

    const refused = await client.callTool({ name: 'list_tasks', arguments: { instance: 'exp' } });
    assert.equal(isError(refused), true);
    assert.match(textOf(refused), /project is required.*default instance \(main\) only/);
    assert.equal(calls.length, 1, 'nothing was sent to the other instance');
  } finally {
    await close();
  }

  // With no default at all, every scoped call needs a project.
  const none: Recorded[] = [];
  const bare = await connectController(none, () => ({ body: {} }));
  try {
    const r = await bare.client.callTool({ name: 'board_summary', arguments: {} });
    assert.match(textOf(r), /project is required.*no default project/);
    assert.equal(none.length, 0);
  } finally {
    await bare.close();
  }
});

test('an unknown or non-loopback instance is an error naming the configured ones; nothing is sent', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(calls, () => ({ body: {} }));
  try {
    for (const instance of ['staging', 'https://lattice.example.com']) {
      const r = await client.callTool({ name: 'get_task', arguments: { instance, project: SANDBOX, id: 't1' } });
      assert.equal(isError(r), true);
      assert.match(textOf(r), /Unknown Lattice instance.*main \(http:\/\/127\.0\.0\.1:5184\), exp/);
    }
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('a response for another project is refused (the guard holds per call)', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(calls, () => ({
    body: { id: 't1', title: 'x', projectPath: 'C:\\other' },
  }));
  try {
    const r = await client.callTool({ name: 'get_task', arguments: { instance: 'exp', project: SANDBOX, id: 't1' } });
    assert.equal(isError(r), true);
    assert.match(textOf(r), /Project mismatch: you asked for C:\\sandbox\\a.*C:\\other/);
  } finally {
    await close();
  }
});

test('run_task forwards harness / piModel / model / effort verbatim, only when given', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(calls, () => ({ body: { accepted: true, queued: false } }));
  try {
    const r = await client.callTool({
      name: 'run_task',
      arguments: { project: SANDBOX, id: 't 1', harness: 'claude', model: 'opus-x', effort: 'high' },
    });
    assert.deepEqual(jsonOf(r), { accepted: true, queued: false });
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/api/tasks/t%201/run');
    assert.equal(url.searchParams.get('project'), SANDBOX);
    assert.deepEqual(JSON.parse(calls[0].body!), { harness: 'claude', model: 'opus-x', effort: 'high' });

    await client.callTool({ name: 'run_task', arguments: { project: SANDBOX, id: 't2' } });
    assert.deepEqual(JSON.parse(calls[1].body!), {});
  } finally {
    await close();
  }
});
