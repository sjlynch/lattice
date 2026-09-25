// A completion callback the outbox replays lands late by design — after the
// backend came back, when the user may already have typed a new instruction
// into the idle agent. `/complete` must then refuse the stale replay instead of
// flipping the task to ready_to_merge and killing the pty mid-turn
// (`callbackOutbox/replayGuard.ts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { createTask, getTask, updateTaskCrashSafe } from '../tasks.js';
import { handleTaskComplete } from '../routes/tasks/hooks/complete.js';
import { OUTBOX_REPLAY_HEADER } from '../callbackOutbox/drain.js';
import {
  isTerminalSubmitFrame,
  noteTaskAgentActivity,
  noteTerminalPromptSubmit,
  outboxReplayQueuedAt,
  resetReplayGuardForTest,
  taskSessionActiveSince,
} from '../callbackOutbox/replayGuard.js';

function fakeReqRes(taskId: string, headers: Record<string, string> = {}) {
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  } as unknown as Response;
  const req = {
    params: { id: taskId },
    query: { source: 'claude-stop-hook-task-complete' },
    headers,
  } as unknown as Request<{ id: string }>;
  return { req, res, status: () => status, body: () => body };
}

// No branch (skips the commit-count probe) and no worktree (so the flip path
// schedules no pty kill) — the guard's hook-activity half needs neither.
async function inProgressTask(title: string) {
  const projectPath = path.join(os.tmpdir(), 'lattice-replay-guard-project');
  const task = await createTask(projectPath, title);
  await updateTaskCrashSafe(task.id, { status: 'in_progress' });
  return task;
}

test('a replayed /complete is refused when the agent showed activity after the Stop it carries', async () => {
  resetReplayGuardForTest();
  const task = await inProgressTask('resumed-after-lost-stop');
  const stopAt = Date.now() - 60_000;
  // The user resumed the agent: its new turn is using tools.
  noteTaskAgentActivity(task.id, stopAt + 30_000);

  const { req, res, status, body } = fakeReqRes(task.id, { [OUTBOX_REPLAY_HEADER]: String(stopAt) });
  await handleTaskComplete('http://127.0.0.1:5184')(req, res);

  assert.equal(status(), 409, 'final, so the drain drops the stale entry');
  assert.deepEqual(body(), { ok: false, error: 'stale-replay', reason: 'agent-activity' });
  assert.equal((await getTask(task.id))?.status, 'in_progress', 'the task was not flipped (and its pty not killed)');
});

test('a replay with no later activity still completes the task; a live callback is never guarded', async () => {
  resetReplayGuardForTest();
  const replayed = await inProgressTask('lost-stop-replayed');
  const stopAt = Date.now() - 60_000;
  // Tool use from the turn that ended (before the Stop) — and a PostToolUse
  // the backend handled a moment after it — are not a new turn.
  noteTaskAgentActivity(replayed.id, stopAt + 1_000);
  const r = fakeReqRes(replayed.id, { [OUTBOX_REPLAY_HEADER]: String(stopAt) });
  await handleTaskComplete('http://127.0.0.1:5184')(r.req, r.res);
  assert.deepEqual(r.body(), { ok: true });
  assert.equal((await getTask(replayed.id))?.status, 'ready_to_merge');

  const live = await inProgressTask('live-stop');
  noteTaskAgentActivity(live.id, Date.now());
  const l = fakeReqRes(live.id);
  await handleTaskComplete('http://127.0.0.1:5184')(l.req, l.res);
  assert.deepEqual(l.body(), { ok: true });
  assert.equal((await getTask(live.id))?.status, 'ready_to_merge');
});

test('a line submitted into a pty in the task worktree after the Stop makes the replay stale', async () => {
  resetReplayGuardForTest();
  const worktreePath = path.join(os.tmpdir(), 'lattice-wt', 'fix-thing-abc12');
  const sessions = [
    { id: 'pty-task', cwd: worktreePath },
    { id: 'pty-other', cwd: path.join(os.tmpdir(), 'lattice-wt', 'other-def34') },
  ];
  const list = async () => sessions;
  const task = { id: 't_x', worktreePath };
  const stopAt = 1_000_000;

  // Typing in ANOTHER task's terminal is not this task's session moving on.
  noteTerminalPromptSubmit('pty-other', stopAt + 5_000);
  assert.equal(await taskSessionActiveSince(task, stopAt, list), null);
  // A submit before the Stop belongs to the turn that ended.
  noteTerminalPromptSubmit('pty-task', stopAt - 5_000);
  assert.equal(await taskSessionActiveSince(task, stopAt, list), null);
  noteTerminalPromptSubmit('pty-task', stopAt + 5_000);
  assert.equal(await taskSessionActiveSince(task, stopAt, list), 'prompt-submitted');
  // Can't list the sessions → no positive evidence → not refused.
  assert.equal(await taskSessionActiveSince(task, stopAt, async () => null), null);
});

test('only a submitted input frame counts as a prompt submit', () => {
  const frame = (o: unknown) => Buffer.from(JSON.stringify(o));
  assert.equal(isTerminalSubmitFrame(frame({ type: 'input', data: '\r' }), false), true);
  assert.equal(isTerminalSubmitFrame(frame({ type: 'input', data: 'fix the bug\r' }), false), true);
  assert.equal(isTerminalSubmitFrame(frame({ type: 'input', data: 'f' }), false), false);
  assert.equal(isTerminalSubmitFrame(frame({ type: 'resize', cols: 80, rows: 24 }), false), false);
  assert.equal(isTerminalSubmitFrame(frame({ type: 'input', data: '\r' }), true), false);
  assert.equal(isTerminalSubmitFrame(Buffer.from('not json "input"'), false), false);
});

test('outboxReplayQueuedAt reads the drain header and ignores junk', () => {
  assert.equal(outboxReplayQueuedAt({ headers: { [OUTBOX_REPLAY_HEADER]: '1234' } }), 1234);
  assert.equal(outboxReplayQueuedAt({ headers: {} }), null);
  assert.equal(outboxReplayQueuedAt({}), null);
  assert.equal(outboxReplayQueuedAt({ headers: { [OUTBOX_REPLAY_HEADER]: 'soon' } }), null);
});
