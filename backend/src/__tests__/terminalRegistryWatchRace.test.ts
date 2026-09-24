import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalRegistryStore, terminalRegistry } from '../terminalRegistry/store.js';
import { reconcileExitedTerminals, readLiveSessions } from '../terminalRegistry/watch.js';
import { restoreProjectTerminals, type RestoreDeps } from '../terminalRegistry/restore.js';
import type { TerminalRecord } from '../terminalRegistry/types.js';

// Races between the registry's "is this pty still live?" reads and a pty that
// is spawned (and recorded) while such a read is in flight. The live view is a
// point-in-time `/sessions` list; a record pointed at a pty after that list
// was requested is missing from it by construction and must not be judged by
// it — ending it deleted a live tab's record, relaunching it put a second
// agent beside the first.

let n = 0;
async function project(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `lattice-watchrace-${++n}-`));
}

function newRecord(projectPath: string, over: Partial<TerminalRecord> = {}) {
  return terminalRegistry.create({
    projectPath,
    cwd: projectPath,
    label: 'shell',
    owner: 'user',
    launch: {},
    serverId: 'tty_fresh',
    serverInstanceId: 'inst-A',
    ...over,
  });
}

test('readLiveSessions stamps the moment the list was requested', async () => {
  const before = Date.now();
  const live = await readLiveSessions({
    probe: async () => ({ kind: 'ready', info: { fingerprint: 'f', instanceId: 'inst-A' } }),
    list: async () => [{ id: 'tty_1' }],
  });
  assert.ok(live);
  assert.ok(live.listedAt !== undefined && live.listedAt >= before && live.listedAt <= Date.now());
  assert.deepEqual([...live.serverIds], ['tty_1']);
});

test('the exit watcher does not end a record whose pty was spawned after the list was requested', async () => {
  const p = await project();
  const listedAt = Date.now();
  // The pty lands (and its record is written) while the GET is in flight.
  const rec = await newRecord(p);
  const ended = await reconcileExitedTerminals({ instanceId: 'inst-A', serverIds: new Set(), listedAt });
  assert.equal(ended, 0);
  assert.equal((await terminalRegistry.get(rec.id, p))?.serverId, 'tty_fresh');

  // The next pass, whose list was requested after the record, still ends it
  // if the pty really is gone (the guard defers, it never exempts).
  const later = await reconcileExitedTerminals({
    instanceId: 'inst-A', serverIds: new Set(), listedAt: Date.now() + 1,
  });
  assert.equal(later, 1);
  assert.equal(await terminalRegistry.get(rec.id, p), null);
});

test('restore adopts (never relaunches) a record pointed at a pty after its live view was taken', async () => {
  const p = await project();
  const listedAt = Date.now();
  // Recorded against a DIFFERENT executor instance than the view, so the
  // exit rule does not apply and the old code fell through to a relaunch.
  const rec = await newRecord(p, { serverInstanceId: 'inst-B', launch: {} });
  const spawns: unknown[] = [];
  const deps: RestoreDeps = {
    readLiveSessions: async () => ({ instanceId: 'inst-A', serverIds: new Set(), listedAt }),
    listLiveSessions: async () => [],
    createSession: async (opts) => { spawns.push(opts); return { id: 'tty_dup' }; },
    killSession: async () => true,
    enqueue: ((args: { thunk: () => Promise<unknown> }) => ({ queued: false, done: args.thunk() })) as unknown as RestoreDeps['enqueue'],
    getTask: async () => null,
    getUserSettings: async () => ({}),
    detectInterruption: async () => ({ interruption: 'unknown', turn: 'unknown', busy: 'unknown', transcriptExists: false }),
    discoverCodexSession: async () => false,
    dirExists: async () => true,
    now: Date.now,
  };
  const summary = await restoreProjectTerminals(p, deps);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(summary.adopted, 1);
  assert.equal(summary.queued, 0);
  assert.equal(spawns.length, 0);
  assert.equal((await terminalRegistry.get(rec.id, p))?.serverId, 'tty_fresh');
});

// Exposes the project write lock so the test can interleave a relaunch
// between noteBusy's snapshot and its write.
class LockableStore extends TerminalRegistryStore {
  hold(projectPath: string, fn: () => Promise<void>): Promise<void> {
    return this.runProjectWrite(projectPath, fn);
  }
  repoint(projectPath: string, id: string, serverId: string): void {
    const list = (this.getCached(this.canonicalize(projectPath)) ?? []).map((r) =>
      r.id === id ? { ...r, serverId } : r);
    this.setCached(this.canonicalize(projectPath), list);
  }
}

test('noteBusy does not stamp a busy verdict onto a record relaunched onto a new pty meanwhile', async () => {
  const p = await project();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-watchrace-store-'));
  const store = new LockableStore({ fileForProject: () => path.join(dir, 'terminals.json'), listKnownProjects: async () => [p] });
  const rec = await store.create({
    projectPath: p, cwd: p, label: 'claude', owner: 'user', launch: {}, serverId: 'tty_old', serverInstanceId: 'inst-A',
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const held = store.hold(p, async () => {
    await gate;
    store.repoint(p, rec.id, 'tty_new'); // the relaunch lands first
  });
  const busy = store.noteBusy(new Set(['tty_old'])); // snapshot names tty_old
  release();
  await held;
  await busy;
  const after = await store.get(rec.id, p);
  assert.equal(after?.serverId, 'tty_new');
  assert.equal(after?.lastBusy, undefined);
});
