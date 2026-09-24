import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { restoreProjectTerminals, type RestoreDeps } from '../terminalRegistry/restore.js';
import type { CreateSessionOptions, CreateSessionResult } from '../terminalServerClient/createSession.js';
import type { TerminalRecord, TerminalRegistryEvent } from '../terminalRegistry/types.js';
import type { Task } from '../tasks.js';
import { RESTORE_NUDGE } from '../terminalRegistry/restoreCommand.js';

// The restore decision matrix, driven through the real registry store (home
// is redirected to a temp dir by the test preload) with every external effect
// injected: live-session view, pty creation, the spawn queue, task lookup,
// settings and the interruption detector.

type Harness = {
  project: string;
  deps: RestoreDeps;
  spawns: CreateSessionOptions[];
  kills: string[];
  events: TerminalRegistryEvent[];
  live: { instanceId: string; ids: string[]; sessions: Array<{ id: string; cwd: string; initialCommand?: string }> };
  tasks: Map<string, Task>;
  settings: Record<string, unknown>;
  interruption: 'interrupted' | 'idle' | 'unknown';
  transcriptExists: boolean;
};

let counter = 0;

async function harness(): Promise<Harness> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), `lattice-restore-${++counter}-`));
  const h: Harness = {
    project,
    spawns: [],
    kills: [],
    events: [],
    live: { instanceId: 'inst-B', ids: [], sessions: [] },
    tasks: new Map(),
    settings: {},
    interruption: 'unknown',
    transcriptExists: true,
    deps: undefined as unknown as RestoreDeps,
  };
  h.deps = {
    readLiveSessions: async () => ({ instanceId: h.live.instanceId, serverIds: new Set(h.live.ids) }),
    listLiveSessions: async () => h.live.sessions,
    createSession: async (opts): Promise<CreateSessionResult> => {
      h.spawns.push(opts);
      const id = `tty_new_${h.spawns.length}`;
      // Mirror what proxyCreateSession's recordSpawnedTerminal does for the
      // existingId path, so the relaunch shows up on the record.
      if (opts.registry?.existingId) {
        await terminalRegistry.update(opts.registry.existingId, {
          serverId: id, serverInstanceId: h.live.instanceId, ended: undefined, restoredAt: Date.now(),
        }, opts.projectPath);
      }
      return { id, terminalId: opts.registry?.existingId };
    },
    killSession: async (id) => { h.kills.push(id); return true; },
    enqueue: ((args: { thunk: () => Promise<unknown> }) => {
      const done = args.thunk();
      return { queued: false, done };
    }) as unknown as RestoreDeps['enqueue'],
    getTask: async (id) => h.tasks.get(id) ?? null,
    getUserSettings: async () => h.settings,
    discoverCodexSession: async () => false,
    detectInterruption: async () => ({
      interruption: h.interruption, turn: 'unknown', busy: 'unknown', transcriptExists: h.transcriptExists,
    }),
    dirExists: async (p) => { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } },
    now: Date.now,
  };
  terminalRegistry.subscribe((e) => { if (e.projectPath === project) h.events.push(e); });
  return h;
}

function record(h: Harness, over: Partial<TerminalRecord> & { serverId?: string }) {
  return terminalRegistry.create({
    projectPath: h.project,
    cwd: h.project,
    label: 'claude 1',
    owner: 'user',
    launch: { initialCommand: 'claude --dangerously-skip-permissions', harness: 'claude' },
    agentSession: { harness: 'claude', id: 'S1', source: 'minted' },
    serverId: 'tty_old',
    serverInstanceId: 'inst-A',
    ...over,
  });
}

// Let the fire-and-forget relaunch thunks settle.
const settle = () => new Promise((r) => setTimeout(r, 20));

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

test('a tab whose relaunch failed is left alone by the on-open pass and retried only on an explicit retry', async () => {
  const h = await harness();
  const r = await record(h, {});
  h.deps.createSession = async () => ({ error: 'no slot today' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  const failed = await terminalRegistry.get(r.id, h.project);
  assert.equal(failed?.ended?.reason, 'restore-failed');
  const firstAt = failed!.ended!.at;
  // The on-open pass neither retries nor re-reports it.
  const quiet = await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.deepEqual(quiet, { status: 'ok', adopted: 0, queued: 0, dropped: [], relaunchedIds: [] });
  // A retry that fails again keeps the ORIGINAL failure time (retention clock).
  const again = await restoreProjectTerminals(h.project, h.deps, { retryFailed: true });
  await settle();
  assert.deepEqual(again.relaunchedIds, [r.id]);
  assert.equal((await terminalRegistry.get(r.id, h.project))?.ended?.at, firstAt);
  // Fixed: the next retry relaunches it and clears the marker.
  h.deps.createSession = async (opts) => {
    await terminalRegistry.update(opts.registry!.existingId!, { serverId: 'tty_retry', serverInstanceId: h.live.instanceId, ended: undefined }, opts.projectPath);
    return { id: 'tty_retry', terminalId: opts.registry!.existingId };
  };
  const summary = await restoreProjectTerminals(h.project, h.deps, { retryFailed: true });
  await settle();
  assert.deepEqual(summary.relaunchedIds, [r.id]);
  const after = await terminalRegistry.get(r.id, h.project);
  assert.equal(after?.ended, undefined);
  assert.equal(after?.serverId, 'tty_retry');
});

test('a retried tab whose pty actually landed is adopted, not spawned beside', async () => {
  const h = await harness();
  const r = await record(h, { serverId: undefined, serverInstanceId: undefined });
  await terminalRegistry.end(r.id, { reason: 'restore-failed', detail: 'bookkeeping blew up' }, h.project);
  h.live.ids = ['tty_landed'];
  h.live.sessions = [{ id: 'tty_landed', cwd: h.project, initialCommand: 'claude --resume S1' }];
  const summary = await restoreProjectTerminals(h.project, h.deps, { retryFailed: true });
  await settle();
  assert.equal(summary.adopted, 1);
  assert.equal(h.spawns.length, 0);
  assert.equal((await terminalRegistry.get(r.id, h.project))?.serverId, 'tty_landed');
});

test('a tab closed while its relaunch is in flight gets the new pty killed instead of orphaned', async () => {
  const h = await harness();
  const r = await record(h, {});
  h.deps.createSession = async (opts) => {
    // The user closes the tab (DELETE /api/terminal-tabs/:id) while the spawn
    // is in flight: the record is gone before the pty lands, so the update
    // recordSpawnedTerminal would do has nothing to attach the pty to.
    await terminalRegistry.end(opts.registry!.existingId!, { reason: 'closed' }, opts.projectPath);
    return { id: 'tty_headless', terminalId: opts.registry!.existingId };
  };
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns.length, 0, 'the fake createSession replaced the recording one');
  assert.deepEqual(h.kills, ['tty_headless'], 'nothing owns that pty — it is killed');
  assert.equal(await terminalRegistry.get(r.id, h.project), null);
  assert.ok(!h.events.some((e) => e.type === 'restored' && e.mode === 'relaunched'), 'no restored event for a closed tab');
});

test('a second restore while relaunches are still in flight is refused, and a relaunched tab is never spawned twice', async () => {
  const h = await harness();
  const r = await record(h, {});
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const original = h.deps.createSession;
  h.deps.createSession = async (opts) => { await gate; return original(opts); };
  const first = await restoreProjectTerminals(h.project, h.deps);
  assert.deepEqual(first.relaunchedIds, [r.id]);
  const second = await restoreProjectTerminals(h.project, h.deps);
  assert.equal(second.status, 'already-running');
  finish();
  await settle();
  await settle();
  assert.equal(h.spawns.length, 1);
  // Once settled, a further pass sees the live pty and only adopts it.
  h.live.ids = ['tty_new_1'];
  const third = await restoreProjectTerminals(h.project, h.deps);
  assert.equal(third.status, 'ok');
  assert.equal(third.adopted, 1);
  assert.equal(h.spawns.length, 1);
});
