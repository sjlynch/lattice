// The terminal restore decision matrix: a live pty is adopted (also an
// unclaimed one in the same cwd + harness, onto a record that lost its id); a
// pty missing while the executor instance is unchanged EXITED (ended, never
// relaunched); a replaced executor's user tab is relaunched with --resume under
// the same tab id, nudged only when the setting is on AND the detector says
// interrupted; a task tab is relaunched with the nudge (per-project opt-out)
// only while its task is in progress, else dropped; one-shot runs are never
// resurrected; a missing cwd drops the tab but keeps its reason; a Claude tab
// that never reached its first turn relaunches fresh under the same id; a
// failed relaunch ends as restore-failed; an unreachable terminal-server
// changes nothing. Review follow-ups: a merge-resolver tab is adopt-only (never
// a second Claude on one conflict), a dead startup record is ended silently
// (the settings re-seed it), and a plain shell never adopts an unrelated live
// non-agent pty in its cwd. Harness: helpers/terminalRestore.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { restoreProjectTerminals } from '../terminalRegistry/restore.js';
import type { Task } from '../tasks.js';
import { RESTORE_NUDGE } from '../terminalRegistry/restoreCommand.js';
import { harness, record, settle } from './helpers/terminalRestore.js';

test('a live pty is adopted without spawning', async () => {
  const h = await harness();
  const r = await record(h, { serverId: 'tty_live', serverInstanceId: 'inst-B' });
  h.live.ids = ['tty_live'];
  const summary = await restoreProjectTerminals(h.project, h.deps);
  assert.deepEqual(summary, { status: 'ok', adopted: 1, queued: 0, dropped: [], relaunchedIds: [] });
  assert.equal(h.spawns.length, 0);
  assert.ok(h.events.some((e) => e.type === 'restored' && e.mode === 'adopted' && e.record.id === r.id));
});

test('an unclaimed live pty in the same cwd + harness is adopted onto a record that lost its id', async () => {
  const h = await harness();
  const r = await record(h, { serverId: undefined, serverInstanceId: undefined });
  h.live.ids = ['tty_orphan'];
  h.live.sessions = [{ id: 'tty_orphan', cwd: h.project.toUpperCase(), initialCommand: 'claude --session-id S1' }];
  const summary = await restoreProjectTerminals(h.project, h.deps);
  assert.equal(summary.adopted, 1);
  assert.equal((await terminalRegistry.get(r.id, h.project))?.serverId, 'tty_orphan');
});

test('a pty missing while the executor instance is unchanged means it EXITED: ended, never relaunched', async () => {
  const h = await harness();
  const r = await record(h, { serverId: 'tty_gone', serverInstanceId: 'inst-B' });
  h.live.ids = [];
  const summary = await restoreProjectTerminals(h.project, h.deps);
  assert.deepEqual(summary, { status: 'ok', adopted: 0, queued: 0, dropped: [], relaunchedIds: [] });
  assert.equal(h.spawns.length, 0);
  assert.equal(await terminalRegistry.get(r.id, h.project), null);
  assert.ok(h.events.some((e) => e.type === 'ended' && e.id === r.id && e.ended.reason === 'exit'));
});

test('a user tab whose executor was replaced is relaunched with --resume under the same tab id', async () => {
  const h = await harness();
  const r = await record(h, {});
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns.length, 1);
  const spawn = h.spawns[0]!;
  assert.equal(spawn.initialCommand, 'claude --dangerously-skip-permissions --resume S1');
  assert.equal(spawn.cwd, h.project);
  assert.equal(spawn.registry?.existingId, r.id);
  assert.equal(spawn.registry?.owner, 'user');
  assert.ok(h.events.some((e) => e.type === 'restored' && e.mode === 'relaunched' && e.record.id === r.id));
  const after = await terminalRegistry.get(r.id, h.project);
  assert.equal(after?.serverId, 'tty_new_1');
});

test('user tabs are nudged only when the setting is on AND the detector says interrupted', async () => {
  const h = await harness();
  await record(h, {});
  h.settings = { restoreNudgeUserTabs: true };
  h.interruption = 'interrupted';
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.ok(h.spawns[0]!.initialCommand!.endsWith(`--resume S1 "${RESTORE_NUDGE.replace(/["\\$`]/g, '\\$&')}"`));

  const h2 = await harness();
  await record(h2, {});
  h2.settings = { restoreNudgeUserTabs: true };
  h2.interruption = 'idle';
  await restoreProjectTerminals(h2.project, h2.deps);
  await settle();
  assert.equal(h2.spawns[0]!.initialCommand, 'claude --dangerously-skip-permissions --resume S1');
});

test('a task tab is relaunched with the nudge while its task is still in progress, else dropped', async () => {
  const h = await harness();
  const wt = path.join(h.project, 'wt');
  await fs.mkdir(wt);
  const live = await record(h, {
    owner: 'task', taskId: 't1', cwd: wt,
    launch: { initialCommand: 'claude --dangerously-skip-permissions "Please read LATTICE_TASK.md"', harness: 'claude', taskId: 't1' },
  });
  const merged = await record(h, {
    owner: 'task', taskId: 't2', cwd: wt, serverId: 'tty_old2',
    launch: { initialCommand: 'claude "x"', harness: 'claude', taskId: 't2' },
  });
  h.tasks.set('t1', { id: 't1', projectPath: h.project, title: 'T1', status: 'in_progress', createdAt: 0, worktreePath: wt } as Task);
  h.tasks.set('t2', { id: 't2', projectPath: h.project, title: 'T2', status: 'qa', createdAt: 0, worktreePath: wt } as Task);
  const summary = await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(summary.queued, 1);
  assert.deepEqual(summary.dropped.map((d) => d.id), [merged.id]);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0]!.taskId, 't1');
  assert.ok(h.spawns[0]!.initialCommand!.includes(`--resume S1 "${RESTORE_NUDGE.replace(/["\\$`]/g, '\\$&')}"`));
  assert.equal(await terminalRegistry.get(merged.id, h.project), null);
  assert.equal((await terminalRegistry.get(live.id, h.project))?.serverId, 'tty_new_1');
});

test('the agent nudge can be turned off per project', async () => {
  const h = await harness();
  const wt = path.join(h.project, 'wt');
  await fs.mkdir(wt);
  await record(h, { owner: 'task', taskId: 't1', cwd: wt });
  h.tasks.set('t1', { id: 't1', projectPath: h.project, title: 'T1', status: 'in_progress', createdAt: 0, worktreePath: wt } as Task);
  h.settings = { restoreNudgeAgents: false };
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns[0]!.initialCommand, 'claude --dangerously-skip-permissions --resume S1');
});

test('one-shot runs are never resurrected; startup tabs are left to their own reseeding', async () => {
  const h = await harness();
  const push = await record(h, { owner: 'push', serverId: 'tty_p' });
  const startup = await record(h, { owner: 'startup', kind: 'startup', startupId: 's1', serverId: 'tty_s', launch: { initialCommand: 'npm run dev' } });
  const summary = await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns.length, 0);
  assert.deepEqual(summary.dropped.map((d) => d.id), [push.id]);
  assert.equal(await terminalRegistry.get(push.id, h.project), null);
  // Startup record survives untouched (not ended, not spawned).
  assert.equal((await terminalRegistry.get(startup.id, h.project))?.ended, undefined);
});

test('a missing working directory drops the tab but keeps the record with its reason', async () => {
  const h = await harness();
  const r = await record(h, { cwd: path.join(h.project, 'nope') });
  const summary = await restoreProjectTerminals(h.project, h.deps);
  assert.equal(summary.dropped.length, 1);
  assert.match(summary.dropped[0]!.reason, /working directory missing/);
  const kept = await terminalRegistry.get(r.id, h.project);
  assert.equal(kept?.ended?.reason, 'cwd-missing');
  assert.equal(h.spawns.length, 0);
});

test('a Claude tab that never reached its first turn is relaunched fresh under the same id', async () => {
  const h = await harness();
  await record(h, { launch: { initialCommand: 'claude --dangerously-skip-permissions "do it"', harness: 'claude' } });
  h.transcriptExists = false;
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns[0]!.initialCommand, 'claude --dangerously-skip-permissions --session-id S1 "do it"');
});

test('a failed relaunch ends the record as restore-failed and reports it', async () => {
  const h = await harness();
  const r = await record(h, {});
  h.deps.createSession = async () => ({ error: 'terminal-server exploded' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.ok(h.events.some((e) => e.type === 'restore-failed' && e.id === r.id && /exploded/.test(e.reason)));
  assert.equal((await terminalRegistry.get(r.id, h.project))?.ended?.reason, 'restore-failed');
});

test('an unreachable terminal-server changes nothing', async () => {
  const h = await harness();
  const r = await record(h, {});
  h.deps.readLiveSessions = async () => null;
  const summary = await restoreProjectTerminals(h.project, h.deps);
  assert.equal(summary.status, 'terminal-server-unreachable');
  assert.equal(h.spawns.length, 0);
  assert.equal((await terminalRegistry.get(r.id, h.project))?.serverId, 'tty_old');
});

// ---- review follow-ups --------------------------------------------------

test('a merge-resolver tab is adopt-only: a live resolver is re-attached, a dead one is ended silently', async () => {
  const h = await harness();
  const wt = path.join(h.project, 'wt');
  await fs.mkdir(wt);
  const alive = await record(h, { owner: 'merge', kind: 'merge', taskId: 'm1', cwd: wt, serverId: 'tty_res', serverInstanceId: 'inst-B' });
  const dead = await record(h, { owner: 'merge', kind: 'merge', taskId: 'm2', cwd: wt, serverId: 'tty_old2' });
  h.live.ids = ['tty_res'];
  h.tasks.set('m1', { id: 'm1', projectPath: h.project, title: 'M1', status: 'ready_to_merge', conflict: true, createdAt: 0, worktreePath: wt } as Task);
  h.tasks.set('m2', { id: 'm2', projectPath: h.project, title: 'M2', status: 'ready_to_merge', conflict: true, createdAt: 0, worktreePath: wt } as Task);
  const summary = await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(summary.adopted, 1);
  assert.deepEqual(summary.relaunchedIds, []);
  assert.deepEqual(summary.dropped, [], 'a dead resolver is not reported as dropped (the merge flow respawns it)');
  assert.equal(h.spawns.length, 0, 'never a second Claude on one conflict');
  assert.equal((await terminalRegistry.get(alive.id, h.project))?.serverId, 'tty_res');
  assert.equal(await terminalRegistry.get(dead.id, h.project), null);
});

test('a dead startup record is ended silently (the settings re-seed it), not relaunched or reported', async () => {
  const h = await harness();
  const r = await record(h, { owner: 'startup', kind: 'startup', startupId: 's1', launch: { initialCommand: 'npm run dev' }, agentSession: undefined });
  const summary = await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns.length, 0);
  assert.deepEqual(summary.dropped, []);
  assert.equal(await terminalRegistry.get(r.id, h.project), null);
});

test('a plain-shell record never adopts an unrelated live non-agent pty in its cwd', async () => {
  const h = await harness();
  const r = await record(h, { launch: {}, agentSession: undefined });
  h.live.ids = ['tty_devserver'];
  h.live.sessions = [{ id: 'tty_devserver', cwd: h.project, initialCommand: 'npm run dev' }];
  const summary = await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(summary.adopted, 0);
  assert.deepEqual(summary.relaunchedIds, [r.id]);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0]!.initialCommand, undefined);
});
