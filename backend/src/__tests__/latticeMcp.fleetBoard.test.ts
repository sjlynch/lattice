// Fleet's cross-project board tools (`fleet_tasks`, `fleet_create_task`,
// `fleet_merge`): each request carries the TARGET project as `project=` and
// every answer is asserted against that project, not the session's own — a
// response for the wrong board is refused. A write on this PC first reads the
// user's agent-control switch from /api/fleet and stops there while it is off;
// a write on a paired PC goes straight to the peer proxy (which checks it), and
// a created-but-not-started task is reported as created so it is never filed twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT, connect, isError, jsonOf, textOf, type Recorded } from './helpers/latticeMcp.js';

const TARGET = 'C:\\other\\proj';

// Answers by route: the fleet snapshot (with the given switch), a bare task of
// the target, a run admission, the merge run; anything else the target's envelope.
function backend(calls: Recorded[], opts: { agentControl?: boolean; runStatus?: number } = {}) {
  return () => {
    const last = calls[calls.length - 1];
    const { pathname } = new URL(last.url);
    if (pathname === '/api/fleet') return { body: { projects: [], agentControl: opts.agentControl === true } };
    if (pathname.endsWith('/run')) return opts.runStatus ? { status: opts.runStatus, body: { error: 'harness pi is not installed' } } : { body: { accepted: true, queued: false } };
    if (pathname.endsWith('/api/tasks') && last.method === 'POST') return { body: { id: 't9', title: 'Fix it', status: 'open', projectPath: TARGET } };
    if (pathname.endsWith('/api/merge-runs')) return { body: { id: 'mr1', projectPath: TARGET, status: 'running' } };
    return { body: { canonicalProject: TARGET, tasks: [] } };
  };
}

const route = (c: Recorded) => {
  const u = new URL(c.url);
  return `${c.method} ${u.pathname}${u.searchParams.get('project') ? ` @${u.searchParams.get('project')}` : ''}`;
};

test('fleet board tools exist only in a fleet session', async () => {
  for (const fleet of [false, true]) {
    const { client, close } = await connect([], undefined, { fleet });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const name of ['fleet_tasks', 'fleet_create_task', 'fleet_merge']) assert.equal(names.includes(name), fleet, name);
    } finally {
      await close();
    }
  }
});

test('fleet_tasks reads the TARGET board, here or on a paired PC, and refuses another board', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, backend(calls), { fleet: true });
  try {
    assert.equal(isError(await client.callTool({ name: 'fleet_tasks', arguments: { targetProject: TARGET, status: 'ready_to_merge' } })), false);
    await client.callTool({ name: 'fleet_tasks', arguments: { targetProject: TARGET, q: 'parser' } });
    await client.callTool({ name: 'fleet_tasks', arguments: { targetProject: TARGET, id: 't1', machine: 'gpu pc' } });
    assert.deepEqual(calls.map(route), [
      `GET /api/tasks @${TARGET}`,
      `GET /api/tasks/search @${TARGET}`,
      `GET /api/peer/gpu%20pc/api/tasks/t1 @${TARGET}`,
    ]);
    assert.equal(new URL(calls[0].url).searchParams.get('status'), 'ready_to_merge');
    assert.equal(new URL(calls[1].url).searchParams.get('q'), 'parser');
  } finally {
    await close();
  }

  // The session's OWN board answering a call aimed at the target is refused.
  const own = await connect([], { body: { canonicalProject: PROJECT, tasks: [] } }, { fleet: true });
  try {
    const res = await own.client.callTool({ name: 'fleet_tasks', arguments: { targetProject: TARGET } });
    assert.equal(isError(res), true);
    assert.match(textOf(res), /Project mismatch/);
  } finally {
    await own.close();
  }
});

test('fleet_create_task: refused here while agent control is off; files + starts once it is on', async () => {
  const off: Recorded[] = [];
  const a = await connect(off, backend(off), { fleet: true });
  try {
    const res = await a.client.callTool({ name: 'fleet_create_task', arguments: { targetProject: TARGET, title: 'Fix it', run: true } });
    assert.equal(isError(res), true);
    assert.match(textOf(res), /Fleet panel .*Ask the user/);
    assert.deepEqual(off.map(route), [`GET /api/fleet @${PROJECT}`], 'nothing written');
  } finally {
    await a.close();
  }

  const on: Recorded[] = [];
  const b = await connect(on, backend(on, { agentControl: true }), { fleet: true });
  try {
    const res = await b.client.callTool({
      name: 'fleet_create_task',
      arguments: { targetProject: TARGET, title: 'Fix it', description: 'brief', run: true, harness: 'pi', piModel: 'endpoint-2/ornith' },
    });
    assert.equal(isError(res), false);
    assert.deepEqual(on.map(route), [`GET /api/fleet @${PROJECT}`, `POST /api/tasks @${TARGET}`, `POST /api/tasks/t9/run @${TARGET}`]);
    assert.deepEqual(JSON.parse(String(on[1].body)), { title: 'Fix it', description: 'brief' });
    assert.deepEqual(JSON.parse(String(on[2].body)), { harness: 'pi', piModel: 'endpoint-2/ornith' });
    assert.deepEqual(jsonOf(res), { task: { id: 't9', title: 'Fix it', status: 'open' }, run: { accepted: true, queued: false } });
  } finally {
    await b.close();
  }
});

test('fleet_create_task on a paired PC skips the local check; a failed start still names the task', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, backend(calls, { runStatus: 400 }), { fleet: true });
  try {
    const res = await client.callTool({ name: 'fleet_create_task', arguments: { targetProject: TARGET, machine: 'gpu', title: 'Fix it', run: true } });
    assert.deepEqual(calls.map(route), [`POST /api/peer/gpu/api/tasks @${TARGET}`, `POST /api/peer/gpu/api/tasks/t9/run @${TARGET}`]);
    assert.equal(isError(res), true);
    const out = jsonOf(res);
    assert.equal(out.task.id, 't9');
    assert.match(out.runError, /not installed/);
  } finally {
    await close();
  }
});

test('fleet_merge: status is a read; starting one is a gated write', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, backend(calls, { agentControl: true }), { fleet: true });
  try {
    await client.callTool({ name: 'fleet_merge', arguments: { targetProject: TARGET, status: true } });
    const started = await client.callTool({ name: 'fleet_merge', arguments: { targetProject: TARGET } });
    assert.equal(isError(started), false);
    assert.deepEqual(calls.map(route), [
      `GET /api/merge-runs/active @${TARGET}`,
      `GET /api/fleet @${PROJECT}`,
      `POST /api/merge-runs @${TARGET}`,
    ]);
  } finally {
    await close();
  }
});
