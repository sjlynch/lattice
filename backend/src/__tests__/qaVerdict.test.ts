import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { buildQaRunsRouter, parseVerdictBody } from '../routes/qaRuns.js';
import { renderQaInstructions } from '../qaRuns/instructions.js';
import {
  applyQaVerdict,
  applyRecordedQaVerdict,
  forgetQaRun,
  getQaRun,
  markQaRunDone,
  recordQaRun,
  recordQaVerdict,
  type QaRun,
} from '../qaRuns.js';
import { createTask, getTask, updateTask } from '../tasks.js';
import type { Task, TaskStatus } from '../tasks.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ---------- parseVerdictBody ----------
//
// This is the LLM-facing edge of the QA auto-advance: the agent hand-builds the
// JSON body for POST /api/qa-runs/:id/verdict. Only a confident PASS should
// read back as passed+confident (the one combination that promotes qa → done).

test('parseVerdictBody: confident pass', () => {
  assert.deepEqual(parseVerdictBody({ verdict: 'pass', confidence: 'high' }), {
    passed: true,
    confident: true,
  });
});

test('parseVerdictBody: pass but low confidence does not auto-advance', () => {
  assert.deepEqual(parseVerdictBody({ verdict: 'pass', confidence: 'low' }), {
    passed: true,
    confident: false,
  });
});

test('parseVerdictBody: fail is never confident-pass', () => {
  assert.deepEqual(parseVerdictBody({ verdict: 'fail', confidence: 'high' }), {
    passed: false,
    confident: true,
  });
});

test('parseVerdictBody: tolerates case / whitespace / "passed"', () => {
  assert.deepEqual(parseVerdictBody({ verdict: ' PASSED ', confidence: ' HIGH ' }), {
    passed: true,
    confident: true,
  });
});

test('parseVerdictBody: boolean shorthand', () => {
  assert.deepEqual(parseVerdictBody({ passed: true, confident: true }), {
    passed: true,
    confident: true,
  });
});

test('parseVerdictBody: empty / garbage body is a non-confident non-pass', () => {
  assert.deepEqual(parseVerdictBody(undefined), { passed: false, confident: false });
  assert.deepEqual(parseVerdictBody({}), { passed: false, confident: false });
  assert.deepEqual(parseVerdictBody({ verdict: 'maybe' }), {
    passed: false,
    confident: false,
  });
});

// ---------- renderQaInstructions ----------
//
// The brief must hand the agent a verdict URL keyed by the run id, and tell it
// the confident-PASS-auto-advances rule, or the agent never reports the verdict
// that closes the QA → Done step.

test('renderQaInstructions: embeds the run-keyed verdict URL + auto-advance step', () => {
  const md = renderQaInstructions({
    projectPath: 'C:/dev/proj',
    qaRunId: 'qa_run_123',
    taskId: 't_abc',
    taskTitle: 'My feature',
    taskDescription: 'Does a thing',
    backendOrigin: 'http://127.0.0.1:5184',
  });
  assert.match(md, /http:\/\/127\.0\.0\.1:5184\/api\/qa-runs\/qa_run_123\/verdict/);
  assert.match(md, /http:\/\/127\.0\.0\.1:5184\/api\/tasks\/t_abc\/append-summary/);
  assert.match(md, /confident PASS auto-moves the task to Done/);
  // No unsubstituted tokens left behind.
  assert.doesNotMatch(md, /\{\{\s*\w+\s*\}\}/);
});

// ---------- forgetQaRun guard ----------
//
// Regression guard for the "passed task stuck in QA" bug: the frontend status
// poller forgets a run (DELETE /api/qa-runs/:id) on any failed poll, including
// a transient one. If that dropped a still-running run, the agent's later
// verdict would land as `tracked:false` and never advance qa → done. So forget
// must refuse to drop a `running` run, and only finalize a `done` one.

function makeRunningRun(id: string) {
  recordQaRun({
    id,
    taskId: 't_does_not_exist',
    projectPath: 'C:/dev/proj',
    cwd: `C:/dev/proj/.scratch/${id}`,
    status: 'running',
    createdAt: 1,
  });
}

test('forgetQaRun: keeps a still-running run so its verdict can still advance it', async () => {
  const id = 'qa_test_running_keep';
  makeRunningRun(id);
  // The frontend poller's transient-failure DELETE must NOT drop a live run.
  forgetQaRun(id);
  assert.ok(getQaRun(id), 'a running run must survive forgetQaRun');

  // A verdict arriving afterward is still tracked (the move itself no-ops only
  // because the throwaway task id does not exist — the point is tracked:true,
  // not the silent tracked:false that caused the stuck-in-QA bug).
  const outcome = await applyQaVerdict(id, { passed: true, confident: true });
  assert.equal(outcome.tracked, true);
  // Tidy up the module-global registry: only a done run can be forgotten.
  markQaRunDone(id);
  forgetQaRun(id);
});

test('forgetQaRun: drops a run once it is marked done', () => {
  const id = 'qa_test_done_drop';
  makeRunningRun(id);
  markQaRunDone(id);
  forgetQaRun(id);
  assert.equal(getQaRun(id), undefined, 'a done run is forgotten normally');
});

// ---------- applyRecordedQaVerdict (Stop-hook /done backstop) ----------
//
// The qa → done transition must not hinge on the agent's explicit /verdict curl
// landing. Mirroring how in_progress → ready_to_merge fires from the reliable
// Stop hook / Pi completion extension, the QA Stop hook's /done callback
// re-applies whatever verdict was recorded. These guard that the backstop
// reaches the promotion path (or correctly stays out of it).

test('applyRecordedQaVerdict: untracked run reports tracked:false', async () => {
  const outcome = await applyRecordedQaVerdict('qa_never_recorded');
  assert.equal(outcome.tracked, false);
  assert.equal(outcome.moved, false);
});

test('applyRecordedQaVerdict: tracked run with no verdict does not move', async () => {
  const id = 'qa_backstop_no_verdict';
  makeRunningRun(id);
  const outcome = await applyRecordedQaVerdict(id);
  assert.equal(outcome.tracked, true);
  assert.equal(outcome.moved, false);
  assert.equal(outcome.reason, 'no verdict recorded');
  markQaRunDone(id);
  forgetQaRun(id);
});

test('applyRecordedQaVerdict: a recorded confident PASS drives the transition from /done', async () => {
  const id = 'qa_backstop_confident_pass';
  makeRunningRun(id);
  // Simulate the agent's /verdict curl having recorded a confident pass.
  recordQaVerdict(id, { passed: true, confident: true, receivedAt: 1 });
  // The Stop hook's /done now re-applies it. The move itself no-ops only
  // because the throwaway task id doesn't exist — the point is that the
  // backstop reaches the promotion path (task lookup) instead of leaving the
  // run untouched (the old "pure cleanup" /done that stranded passed tasks).
  const outcome = await applyRecordedQaVerdict(id);
  assert.equal(outcome.tracked, true);
  assert.equal(outcome.reason, 'task not found');
  markQaRunDone(id);
  forgetQaRun(id);
});

test('applyRecordedQaVerdict: a recorded FAIL is never promoted', async () => {
  const id = 'qa_backstop_fail';
  makeRunningRun(id);
  recordQaVerdict(id, { passed: false, confident: true, receivedAt: 1 });
  const outcome = await applyRecordedQaVerdict(id);
  assert.equal(outcome.moved, false);
  assert.equal(outcome.reason, 'verdict: fail');
  markQaRunDone(id);
  forgetQaRun(id);
});

// ---------- POST /api/qa-runs status guard ----------
//
// A QA e2e session must only start for a task that's actually in the QA lane.
// A stale/miswired frontend call (or a direct API hit) against an
// open/in_progress/ready_to_merge/done task would burn an agent/PTY on unmerged
// or already-shipped code and append a misleading verdict — and a confident
// PASS recorded from such a run could later promote the wrong code state to
// done. The route must reject every non-QA status with 409 and spawn nothing,
// while a genuine QA-lane task still starts a run.

function fixtureTask(status: TaskStatus): Task {
  return {
    id: 't_qa_guard',
    projectPath: 'C:/dev/proj',
    title: 'My feature',
    description: 'Does a thing',
    status,
    createdAt: 0,
  };
}

// Mount the real router with getTask/startQaSession stubbed, so we exercise the
// actual route guards over HTTP without touching the task DB or spawning a
// Claude session. `startCalls()` counts how many times a session would have been
// started — i.e. whether any session/registry entry was created.
async function withQaRunsHarness(
  task: Task | null,
  fn: (ctx: {
    post: (body: unknown) => Promise<{ status: number; body: { error?: string; taskId?: string; serverId?: string } }>;
    startCalls: () => number;
  }) => Promise<void>,
): Promise<void> {
  let startCalls = 0;
  const app = express();
  app.use(express.json());
  app.use(
    buildQaRunsRouter('http://127.0.0.1:5184', {
      getTask: async () => task,
      startQaSession: async (args) => {
        startCalls += 1;
        return {
          id: 'qa_stub_run',
          taskId: args.taskId,
          cwd: 'C:/scratch/qa_stub_run',
          command: 'claude --dangerously-skip-permissions "..."',
          serverId: 'srv_stub',
        };
      },
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const post = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/qa-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as { error?: string; taskId?: string; serverId?: string },
    };
  };
  try {
    await fn({ post, startCalls: () => startCalls });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const NON_QA_STATUSES: TaskStatus[] = [
  'backlog',
  'open',
  'in_progress',
  'ready_to_merge',
  'done',
  'deleted',
];

for (const status of NON_QA_STATUSES) {
  test(`POST /api/qa-runs: refuses to start a QA run for a ${status} task (409, no session)`, async () => {
    await withQaRunsHarness(fixtureTask(status), async ({ post, startCalls }) => {
      const res = await post({ project: 'C:/dev/proj', taskId: 't_qa_guard' });
      assert.equal(res.status, 409, `expected 409 for status=${status}`);
      assert.match(res.body.error ?? '', /not in QA/i);
      // The whole point of the fix: no Playwright session / registry entry was
      // created for a task that isn't in the QA lane.
      assert.equal(startCalls(), 0, `a ${status} task must spawn no QA session`);
    });
  });
}

test('POST /api/qa-runs: starts a QA run for a task in the QA lane', async () => {
  await withQaRunsHarness(fixtureTask('qa'), async ({ post, startCalls }) => {
    const res = await post({ project: 'C:/dev/proj', taskId: 't_qa_guard' });
    assert.equal(res.status, 200);
    assert.equal(res.body.taskId, 't_qa_guard');
    assert.equal(res.body.serverId, 'srv_stub');
    assert.equal(startCalls(), 1, 'a qa-lane task must start exactly one session');
  });
});

test('POST /api/qa-runs: a missing task is 404 and spawns nothing', async () => {
  await withQaRunsHarness(null, async ({ post, startCalls }) => {
    const res = await post({ project: 'C:/dev/proj', taskId: 't_qa_guard' });
    assert.equal(res.status, 404);
    assert.equal(startCalls(), 0);
  });
});

test('POST /api/qa-runs: a task in another project is rejected and spawns nothing', async () => {
  // Ownership guard precedes the status guard: even a qa-lane task can't be run
  // under the wrong project.
  await withQaRunsHarness(fixtureTask('qa'), async ({ post, startCalls }) => {
    const res = await post({ project: 'C:/dev/other', taskId: 't_qa_guard' });
    assert.equal(res.status, 400);
    assert.equal(startCalls(), 0);
  });
});

// ---------- /verdict racing the /done backstop ----------
//
// The agent's explicit /verdict curl and its own Stop hook's /done can land
// together. Both used to pass the `movedToDone` check before either's
// updateTask resolved, so the task was written twice and both reported
// `moved: true`. Exactly one trigger performs the move now.

test('a concurrent /verdict and /done backstop promote the task exactly once', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'lattice-qa-race-'));
  try {
    const task = await createTask(project, 'QA race');
    await updateTask(task.id, { status: 'qa' });
    const id = 'qa_race_verdict_done';
    recordQaRun({
      id,
      taskId: task.id,
      projectPath: task.projectPath,
      cwd: path.join(project, 'scratch'),
      status: 'running',
      // Started after the task landed in QA (its `mergedAt`), like a real run.
      createdAt: Date.now(),
    });
    recordQaVerdict(id, { passed: true, confident: true, receivedAt: 1 });
    const outcomes = await Promise.all([
      applyQaVerdict(id, { passed: true, confident: true }),
      applyRecordedQaVerdict(id),
    ]);
    assert.equal(outcomes.filter((o) => o.moved).length, 1, JSON.stringify(outcomes));
    assert.equal((await getTask(task.id))?.status, 'done');
    markQaRunDone(id);
    forgetQaRun(id);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

// ---------- stale verdicts ----------
//
// A verdict is about the build the run tested. If the task was dragged out of
// QA while the run was going, reworked and merged back in, the recorded PASS
// describes the OLD code: re-applying it (a later /done, boot recovery's
// lost-run settlement) must not ship the new build to Done. Nor may a run that
// was already settled re-apply its verdict at all.

test('applyRecordedQaVerdict: a PASS recorded before the task was re-merged into QA does not promote it', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'lattice-qa-stale-'));
  try {
    const task = await createTask(project, 'QA stale verdict');
    await updateTask(task.id, { status: 'qa', mergedAt: 1000 });
    const id = 'qa_stale_remerged';
    recordQaRun({
      id,
      taskId: task.id,
      projectPath: task.projectPath,
      cwd: path.join(project, 'scratch'),
      status: 'running',
      createdAt: 2000,
    });
    // Dragged out of QA for rework; the run's confident PASS lands meanwhile.
    await updateTask(task.id, { status: 'in_progress' });
    const early = await applyQaVerdict(id, { passed: true, confident: true });
    assert.equal(early.moved, false);
    // Reworked and merged back into QA — a newer build than the run tested.
    await updateTask(task.id, { status: 'qa', mergedAt: 3000 });
    const outcome = await applyRecordedQaVerdict(id);
    assert.equal(outcome.moved, false);
    assert.equal(outcome.reason, 'task re-merged after the QA run started');
    assert.equal((await getTask(task.id))?.status, 'qa');
    markQaRunDone(id);
    forgetQaRun(id);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('applyRecordedQaVerdict: a settled run never re-applies its verdict', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'lattice-qa-settled-'));
  try {
    const task = await createTask(project, 'QA settled run');
    await updateTask(task.id, { status: 'qa', mergedAt: 1000 });
    const id = 'qa_settled_no_reapply';
    recordQaRun({
      id,
      taskId: task.id,
      projectPath: task.projectPath,
      cwd: path.join(project, 'scratch'),
      status: 'running',
      createdAt: 2000,
    });
    recordQaVerdict(id, { passed: true, confident: true, receivedAt: 2500 });
    // Closed by an earlier /done (e.g. while the task was out of QA).
    markQaRunDone(id);
    const outcome = await applyRecordedQaVerdict(id);
    assert.equal(outcome.moved, false);
    assert.equal(outcome.reason, 'run already settled');
    assert.equal((await getTask(task.id))?.status, 'qa');
    forgetQaRun(id);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

// ---------- one QA session per task ----------
//
// The QA card's ▶ could start a second Playwright session for a task already
// under test: both drove the browser against the same dev server and both
// posted verdicts, so either one's confident PASS promoted the task. The route
// now refuses a start while a QA run for the task is running (or starting).

type DupHarness = {
  post: () => Promise<{ status: number; body: { error?: string; runId?: string } }>;
  startCalls: () => number;
  runs: QaRun[];
};

// Mounts the real router with the registry + terminal-server probe injected.
// The stubbed session records its run the way the real one does (only after
// its pty "spawned", i.e. once `gate` resolves) and reports that pty live via
// `sessions()` unless the test says otherwise.
async function withDuplicateHarness(
  opts: {
    gate?: Promise<void>;
    sessions?: (runs: QaRun[]) => unknown[] | null;
  },
  fn: (ctx: DupHarness) => Promise<void>,
): Promise<void> {
  const runs: QaRun[] = [];
  let startCalls = 0;
  const app = express();
  app.use(express.json());
  app.use(
    buildQaRunsRouter('http://127.0.0.1:5184', {
      getTask: async () => fixtureTask('qa'),
      listRunningQaRuns: () => runs.filter((r) => r.status === 'running'),
      listSessions: async () =>
        opts.sessions ? opts.sessions(runs) : runs.map((r) => ({ id: `srv_${r.id}`, cwd: r.cwd })),
      startQaSession: async (args) => {
        startCalls += 1;
        const id = `qa_dup_${startCalls}`;
        const cwd = `C:/scratch/${id}`;
        await opts.gate;
        runs.push({
          id,
          taskId: args.taskId,
          projectPath: args.projectPath,
          cwd,
          status: 'running',
          createdAt: Date.now(),
        });
        return { id, taskId: args.taskId, cwd, command: 'claude', serverId: `srv_${id}` };
      },
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const post = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/qa-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'C:/dev/proj', taskId: 't_qa_guard' }),
    });
    return { status: res.status, body: (await res.json()) as { error?: string; runId?: string } };
  };
  try {
    await fn({ post, startCalls: () => startCalls, runs });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('POST /api/qa-runs: a second start while the first run is running is 409 and spawns nothing', async () => {
  await withDuplicateHarness({}, async ({ post, startCalls }) => {
    const first = await post();
    assert.equal(first.status, 200);
    const second = await post();
    assert.equal(second.status, 409);
    assert.match(second.body.error ?? '', /already running/i);
    assert.equal(second.body.runId, 'qa_dup_1');
    assert.equal(startCalls(), 1, 'the duplicate must not start a second session');
  });
});

test('POST /api/qa-runs: two simultaneous starts for one task spawn exactly one session', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withDuplicateHarness({ gate }, async ({ post, startCalls }) => {
    const firstP = post();
    // Let the first request reach the (gated) spawn before the second lands.
    while (startCalls() === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await post();
    assert.equal(second.status, 409);
    assert.match(second.body.error ?? '', /already starting/i);
    release();
    assert.equal((await firstP).status, 200);
    assert.equal(startCalls(), 1);
  });
});

test('POST /api/qa-runs: a settled run no longer blocks a re-test', async () => {
  await withDuplicateHarness({}, async ({ post, startCalls, runs }) => {
    assert.equal((await post()).status, 200);
    runs[0].status = 'done';
    assert.equal((await post()).status, 200);
    assert.equal(startCalls(), 2);
  });
});

test('POST /api/qa-runs: a run whose pty is gone (tab closed, no /done) does not block a re-test', async () => {
  await withDuplicateHarness({ sessions: () => [] }, async ({ post, startCalls }) => {
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    assert.equal(startCalls(), 2);
  });
});

test('POST /api/qa-runs: an unreachable terminal-server counts a tracked run as live (409)', async () => {
  await withDuplicateHarness({ sessions: () => null }, async ({ post, startCalls }) => {
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 409);
    assert.equal(startCalls(), 1);
  });
});
