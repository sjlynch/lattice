// Controller mode's workflow tools (`latticeMcp/tools/workflowTools.ts`,
// harness: helpers/latticeMcp.ts) against a fake backend. Pinned: the exact
// route + `?project=` pin each tool uses, that overrides and step lists reach
// the API VERBATIM (model / effort fields are being added server-side; the MCP
// must not filter them), that runs come back COMPACT (no step prompts — a run
// carries its whole definition), that a second start's 409 says what to do,
// and that `wait_workflow_run` both finishes and times out without real time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXP, SANDBOX, connectController, isError, jsonOf, textOf, type Recorded } from './helpers/latticeMcp.js';

const WF = {
  id: 'wf_1',
  name: 'Variant A',
  projectPath: SANDBOX,
  createdAt: 1,
  steps: [
    { id: 's1', title: 'Plan', prompt: 'P'.repeat(300), kind: 'agent', harness: 'claude', effort: 'high' },
    { id: 's2', title: 'Start', prompt: '', kind: 'start', harness: 'claude' },
  ],
  variables: [{ id: 'v1', name: 'user_instructions', value: 'long text' }],
};

function run(status: string, extra: object = {}) {
  return {
    id: 'run_1',
    workflowId: 'wf_1',
    workflowName: 'Variant A',
    projectPath: SANDBOX,
    status,
    startedAt: 1_000,
    totalSteps: 2,
    currentStepIndex: 1,
    effortOverride: 'low',
    definition: WF,
    roundTaskIds: ['t1'],
    stepStates: { 0: { stepId: 's1', phase: 'completed' }, 1: { stepId: 's2', phase: 'running', sessionId: 'pty1' } },
    stepSummaries: { 0: 'S'.repeat(1000) },
    ...extra,
  };
}

const at = (calls: Recorded[], i: number) => {
  const u = new URL(calls[i].url);
  return { method: calls[i].method, where: u.origin + u.pathname, project: u.searchParams.get('project'), body: calls[i].body };
};

test('list_workflows is compact; get_workflow returns the full definition', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(calls, () => ({ body: [WF] }));
  try {
    const list = jsonOf(await client.callTool({ name: 'list_workflows', arguments: { instance: 'exp', project: SANDBOX } }));
    assert.deepEqual(at(calls, 0), { method: 'GET', where: `${EXP}/api/workflows`, project: SANDBOX, body: undefined });
    assert.deepEqual(list[0].steps[0], { index: 0, title: 'Plan', kind: 'agent', harness: 'claude', effort: 'high', promptChars: 300 });
    assert.deepEqual(list[0].variables, ['user_instructions']);
    assert.ok(!JSON.stringify(list).includes('PPPP'), 'no prompts in the listing');

    const full = jsonOf(await client.callTool({ name: 'get_workflow', arguments: { project: SANDBOX, id: 'wf_1' } }));
    assert.deepEqual(full, WF);
    const missing = await client.callTool({ name: 'get_workflow', arguments: { project: SANDBOX, id: 'nope' } });
    assert.equal(isError(missing), true);
  } finally {
    await close();
  }
});

test('save_workflow POSTs without an id and PATCHes with one, passing steps through verbatim', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(calls, () => ({ body: WF }));
  try {
    const steps = [{ title: 'Plan', prompt: 'x', harness: 'codex', model: 'gpt-x', effort: 'xhigh', futureField: 1 }];
    const created = jsonOf(await client.callTool({ name: 'save_workflow', arguments: { project: SANDBOX, name: 'V', steps } }));
    assert.deepEqual(at(calls, 0), {
      method: 'POST', where: 'http://127.0.0.1:5184/api/workflows', project: SANDBOX,
      body: JSON.stringify({ name: 'V', steps }),
    });
    assert.equal(created.id, 'wf_1');
    assert.ok(!('projectPath' in created));

    await client.callTool({ name: 'save_workflow', arguments: { project: SANDBOX, id: 'wf_1', variables: [{ name: 'goal', value: 'g' }] } });
    assert.equal(at(calls, 1).method, 'PATCH');
    assert.equal(at(calls, 1).where, 'http://127.0.0.1:5184/api/workflows/wf_1');
    assert.deepEqual(JSON.parse(calls[1].body!), { variables: [{ name: 'goal', value: 'g' }] });

    await client.callTool({ name: 'delete_workflow', arguments: { project: SANDBOX, id: 'wf_1' } });
    assert.deepEqual([at(calls, 2).method, at(calls, 2).where, at(calls, 2).project],
      ['DELETE', 'http://127.0.0.1:5184/api/workflows/wf_1', SANDBOX]);
  } finally {
    await close();
  }
});

test('start_workflow_run sends overrides verbatim and returns the compact run', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(calls, () => ({ body: { run: run('running') } }));
  try {
    const overrides = { harnessOverride: 'pi', piModelOverride: 'p/m', agentModelOverride: 'x', effortOverride: 'low' };
    const r = jsonOf(await client.callTool({ name: 'start_workflow_run', arguments: { project: SANDBOX, id: 'wf_1', overrides } }));
    assert.deepEqual(at(calls, 0), {
      method: 'POST', where: 'http://127.0.0.1:5184/api/workflows/wf_1/run', project: SANDBOX, body: JSON.stringify(overrides),
    });
    // Compact: scalars (new overrides included), steps with phase; no definition / prompts.
    assert.equal(r.status, 'running');
    assert.equal(r.effortOverride, 'low');
    assert.ok(!('definition' in r) && !('stepStates' in r) && !JSON.stringify(r).includes('PPPP'));
    assert.deepEqual(r.steps[1], { index: 1, title: 'Start', kind: 'start', harness: 'claude', phase: 'running', sessionId: 'pty1' });
    assert.equal(r.steps[0].phase, 'completed');
    assert.equal(r.steps[0].summaryChars, 1000);
    assert.ok(r.steps[0].summary.length < 700);
    assert.deepEqual(r.roundTaskIds, ['t1']);
  } finally {
    await close();
  }
});

test('a second start (409 active-run-exists) is an error that says what to do', async () => {
  const { client, close } = await connectController([], () => ({
    status: 409, body: { error: 'a run is active', code: 'active-run-exists' },
  }));
  try {
    const r = await client.callTool({ name: 'start_workflow_run', arguments: { project: SANDBOX, id: 'wf_1' } });
    assert.equal(isError(r), true);
    assert.match(textOf(r), /already active for C:\\sandbox\\a.*wait_workflow_run.*cancel_workflow_run/s);
  } finally {
    await close();
  }
});

test('get / list / cancel workflow runs hit the pinned run routes; a foreign run is refused', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connectController(calls, ({ url }) => {
    if (url.pathname.endsWith('/active')) return { body: [run('running')] };
    if (url.pathname.endsWith('/cancel')) return { body: { ok: true } };
    if (url.pathname.endsWith('/foreign')) return { body: { run: { ...run('running'), projectPath: 'C:\\other' } } };
    return { body: { run: run('completed', { finishedAt: 61_000 }) } };
  });
  try {
    const one = jsonOf(await client.callTool({ name: 'get_workflow_run', arguments: { project: SANDBOX, runId: 'run_1' } }));
    assert.equal(at(calls, 0).where, 'http://127.0.0.1:5184/api/workflow-runs/run_1');
    assert.equal(at(calls, 0).project, SANDBOX);
    assert.equal(one.elapsedSec, 60);

    const active = jsonOf(await client.callTool({ name: 'list_workflow_runs', arguments: { project: SANDBOX } }));
    assert.equal(at(calls, 1).where, 'http://127.0.0.1:5184/api/workflow-runs/active');
    assert.equal(active.length, 1);

    await client.callTool({ name: 'cancel_workflow_run', arguments: { project: SANDBOX, runId: 'run_1' } });
    assert.deepEqual([at(calls, 2).method, at(calls, 2).where], ['POST', 'http://127.0.0.1:5184/api/workflow-runs/run_1/cancel']);

    const foreign = await client.callTool({ name: 'get_workflow_run', arguments: { project: SANDBOX, runId: 'foreign' } });
    assert.equal(isError(foreign), true);
    assert.match(textOf(foreign), /Project mismatch/);
  } finally {
    await close();
  }
});

test('wait_workflow_run polls until the run finishes', async () => {
  const calls: Recorded[] = [];
  const sleeps: number[] = [];
  let polls = 0;
  const { client, close } = await connectController(
    calls,
    () => ({ body: { run: ++polls < 3 ? run('running') : run('errored', { error: 'step 2 failed' }) } }),
    { sleeps },
  );
  try {
    const r = jsonOf(await client.callTool({ name: 'wait_workflow_run', arguments: { project: SANDBOX, runId: 'run_1' } }));
    assert.equal(r.done, true);
    assert.equal(r.run.status, 'errored');
    assert.equal(r.run.error, 'step 2 failed');
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [10_000, 10_000]);
  } finally {
    await close();
  }
});

test('wait_workflow_run returns done:false (not an error) when the timeout passes', async () => {
  const calls: Recorded[] = [];
  const sleeps: number[] = [];
  const { client, close } = await connectController(calls, () => ({ body: { run: run('running') } }), { sleeps });
  try {
    const r = await client.callTool({ name: 'wait_workflow_run', arguments: { project: SANDBOX, runId: 'run_1', timeoutSeconds: 25 } });
    assert.equal(isError(r), false);
    const body = jsonOf(r);
    assert.equal(body.done, false);
    assert.match(body.note, /Still running after 25 s; call wait_workflow_run again/);
    // Polled at 0, 10, 20 and 25 s — the last sleep is cut to the remaining time.
    assert.deepEqual(sleeps, [10_000, 10_000, 5_000]);
    assert.equal(calls.length, 4);

    const bad = await client.callTool({ name: 'wait_workflow_run', arguments: { project: SANDBOX, runId: 'run_1', timeoutSeconds: 3601 } });
    assert.equal(isError(bad), true, 'over the 3600 s cap is refused by the schema');
  } finally {
    await close();
  }
});
