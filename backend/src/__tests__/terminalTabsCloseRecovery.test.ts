// A registered close must persist intent before kill IO without discarding the
// serverId on a 503 / lost connection. Exercise the real route and executor
// client; existing post-merge abort and store assertions remain unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RestoreDeps } from '../terminalRegistry/restore.js';
import type { TerminalRecord, TerminalRegistryEvent } from '../terminalRegistry/types.js';

let executor!: http.Server;
let mode: '503' | 'disconnect' | '200' | '404' | 'hold' = '200';
let releaseKill: (() => void) | undefined;
let killStarted: (() => void) | undefined;
const attempts: string[] = [];
const live = new Set<string>();
let terminalRegistry: (typeof import('../terminalRegistry/store.js'))['terminalRegistry'];
let TerminalRegistryStore: (typeof import('../terminalRegistry/store.js'))['TerminalRegistryStore'];
let terminalsFile: (typeof import('../terminalRegistry/store.js'))['terminalsFile'];
let deserializeTerminalRecords: (typeof import('../terminalRegistry/store.js'))['deserializeTerminalRecords'];
let buildRouter: (typeof import('../routes/terminalTabs.js'))['buildTerminalTabsRouter'];
let restore: (typeof import('../terminalRegistry/restore.js'))['restoreProjectTerminals'];
let enqueueRelaunch: (typeof import('../terminalRegistry/restoreRelaunch.js'))['enqueueRelaunch'];
let recordSpawnedTerminal: (typeof import('../terminalServerClient/recordSpawn.js'))['recordSpawnedTerminal'];
let proxyKillSession: (typeof import('../terminalServerClient/sessions.js'))['proxyKillSession'];

before(async () => {
  executor = http.createServer((req, res) => {
    const id = /^\/sessions\/([^/?]+)$/.exec(req.url ?? '')?.[1];
    if (req.method !== 'DELETE' || !id) { res.writeHead(404); res.end(); return; }
    attempts.push(decodeURIComponent(id));
    if (mode === 'disconnect') { req.socket.destroy(); return; }
    if (mode === '503') { res.writeHead(503); res.end('unavailable'); return; }
    const finish = () => {
      if (mode === '404') res.writeHead(404);
      else { live.delete(decodeURIComponent(id)); res.writeHead(200, { 'content-type': 'application/json' }); }
      res.end('{"ok":true}');
    };
    if (mode === 'hold') { releaseKill = finish; killStarted?.(); }
    else finish();
  });
  await new Promise<void>((resolve) => executor.listen(0, '127.0.0.1', resolve));
  process.env.TERMINAL_PORT = String((executor.address() as AddressInfo).port);
  ({ terminalRegistry, TerminalRegistryStore, terminalsFile, deserializeTerminalRecords } = await import('../terminalRegistry/store.js'));
  ({ buildTerminalTabsRouter: buildRouter } = await import('../routes/terminalTabs.js'));
  ({ restoreProjectTerminals: restore } = await import('../terminalRegistry/restore.js'));
  ({ enqueueRelaunch } = await import('../terminalRegistry/restoreRelaunch.js'));
  ({ recordSpawnedTerminal } = await import('../terminalServerClient/recordSpawn.js'));
  ({ proxyKillSession } = await import('../terminalServerClient/sessions.js'));
});

after(async () => {
  await terminalRegistry.flushAll();
  await new Promise<void>((resolve) => executor.close(() => resolve()));
});

async function setup(over: Partial<TerminalRecord> = {}) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-close-recovery-'));
  const record = await terminalRegistry.create({
    projectPath: project, cwd: project, label: 'agent', owner: 'user', launch: {},
    serverId: `pty_${path.basename(project)}`, serverInstanceId: 'instance', ...over,
  });
  if (record.serverId) live.add(record.serverId);
  return { project, record };
}

async function withApp(run: (base: string) => Promise<void>, onRequest?: () => void) {
  const app = express();
  app.use((req, _res, next) => { if (req.method === 'DELETE') onRequest?.(); next(); });
  app.use(buildRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function close(base: string, record: TerminalRecord) {
  return fetch(`${base}/api/terminal-tabs/${record.id}?project=${encodeURIComponent(record.projectPath)}`, { method: 'DELETE' });
}

for (const failure of ['503', 'disconnect'] as const) {
  test(`executor ${failure}: intent and PTY survive on disk, then the same tab id can reclaim it`, async () => {
    const { project, record } = await setup();
    const events: TerminalRegistryEvent[] = [];
    const unsub = terminalRegistry.subscribe((e) => { if (e.projectPath === project) events.push(e); });
    const start = attempts.length;
    try {
      await withApp(async (base) => {
        mode = failure;
        const failed = await close(base, record);
        assert.equal(failed.status, 503);
        assert.equal((await failed.json() as { code: string }).code, 'terminal-close-unconfirmed');
        assert.ok(live.has(record.serverId!), 'an uncertain DELETE does not prove PTY removal');
        const pending = await terminalRegistry.get(record.id, project);
        assert.equal(pending?.serverId, record.serverId);
        assert.equal(pending?.closePending, true);
        assert.equal(pending?.ended?.reason, 'closed');
        assert.equal(events.some((e) => e.type === 'ended' || e.type === 'removed'), false);
        const fresh = new TerminalRegistryStore();
        assert.deepEqual(await fresh.get(record.id, project), pending, 'intent is durable before retry');
        const snapshot = await fetch(`${base}/api/terminal-tabs?project=${encodeURIComponent(project)}`);
        assert.equal((await snapshot.json() as { tabs: TerminalRecord[] }).tabs[0]?.closePending, true);

        mode = '200';
        const retried = await close(base, record);
        assert.equal(retried.status, 200);
        assert.deepEqual(await retried.json(), { ok: true });
        assert.equal(live.has(record.serverId!), false);
        assert.equal(await terminalRegistry.get(record.id, project), null);
        assert.equal((await close(base, record)).status, 404, 'a later retry issues no duplicate live teardown');
        assert.deepEqual(attempts.slice(start), [record.serverId, record.serverId]);
      });
    } finally { unsub(); }
  });
}

test('executor not-found confirms absence, while overlapping route closes share one live teardown', async () => {
  const absent = await setup();
  live.delete(absent.record.serverId!);
  mode = '404';
  await withApp(async (base) => {
    assert.equal((await close(base, absent.record)).status, 200);
    assert.equal(await terminalRegistry.get(absent.record.id, absent.project), null);
  });
  const { record, project } = await setup();
  mode = 'hold';
  const started = new Promise<void>((resolve) => { killStarted = resolve; });
  let requestCount = 0;
  let secondArrived!: () => void;
  const bothArrived = new Promise<void>((resolve) => { secondArrived = resolve; });
  const start = attempts.length;
  try {
    await withApp(async (base) => {
      const first = close(base, record);
      const second = close(base, record);
      await Promise.all([started, bothArrived]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(await terminalRegistry.get(record.id, project), 'ownership stays until executor acknowledgement');
      releaseKill!();
      assert.deepEqual((await Promise.all([first, second])).map((r) => r.status), [200, 200]);
      assert.deepEqual(attempts.slice(start), [record.serverId]);
      assert.equal(await terminalRegistry.get(record.id, project), null);
    }, () => { if (++requestCount === 2) secondArrived(); });
  } finally { killStarted = undefined; releaseKill = undefined; }
});

test('close tombstones resist stale restore writes, cleanup ends, and retention pruning', async () => {
  const { project, record } = await setup();
  const pending = await terminalRegistry.requestClose(record.id, project);
  const staleEvents: TerminalRegistryEvent[] = [];
  const unsubscribe = terminalRegistry.subscribe((e) => { if (e.projectPath === project) staleEvents.push(e); });
  terminalRegistry.emitRestored(record, 'adopted');
  terminalRegistry.emitRestoreFailed(record, 'stale failure');
  unsubscribe();
  assert.deepEqual(staleEvents, [], 'stale restore notifications cannot reopen or erase pending ownership');
  await terminalRegistry.update(record.id, {
    ended: undefined, closePending: undefined, serverId: undefined, relaunching: true,
  }, project);
  assert.deepEqual(await terminalRegistry.get(record.id, project), pending);
  assert.equal(await terminalRegistry.end(record.id, { reason: 'restore-failed' }, project), false);
  assert.equal(await terminalRegistry.end(record.id, { reason: 'owner-finished' }, project), false);
  const old = { ...pending, ended: { reason: 'closed', at: Date.now() - 30 * 24 * 3600_000 } };
  assert.equal(deserializeTerminalRecords([old])?.[0]?.serverId, record.serverId, 'uncertain ownership never ages out');
  const disk = JSON.parse(await fs.readFile(terminalsFile(project), 'utf8'));
  assert.equal(deserializeTerminalRecords(disk)?.[0]?.closePending, true);
});

test('only spawn bookkeeping may hand a late PTY to a serverless close tombstone', async () => {
  const { project, record } = await setup({ serverId: undefined, relaunching: true });
  await terminalRegistry.requestClose(record.id, project);
  await terminalRegistry.update(record.id, { serverId: 'unrelated-orphan', ended: undefined }, project);
  assert.equal((await terminalRegistry.get(record.id, project))?.serverId, undefined);
  const attached = await terminalRegistry.recordRelaunch(record.id, {
    serverId: 'actual-late-spawn', serverInstanceId: 'instance', ended: undefined, relaunching: undefined,
  }, project);
  assert.equal(attached?.serverId, 'actual-late-spawn');
  assert.equal(attached?.ended?.reason, 'closed');
  assert.equal(attached?.closePending, true);
});

test('a failed intent write surfaces the error and still blocks restore in memory until retry', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-close-write-failure-'));
  class FailingStore extends TerminalRegistryStore {
    fail = false;
    protected override async writeStateNow(p: string, state: TerminalRecord[]): Promise<void> {
      if (this.fail) throw new Error('intent write failed');
      await super.writeStateNow(p, state);
    }
  }
  const store = new FailingStore({ fileForProject: () => path.join(project, 'registry.json') });
  const record = await store.create({ projectPath: project, cwd: project, label: 'agent', owner: 'user', launch: {}, serverId: 'live' });
  try {
    store.fail = true;
    await assert.rejects(store.requestClose(record.id, project), /intent write failed/);
    assert.equal((await store.get(record.id, project))?.closePending, true);
    assert.equal((await store.get(record.id, project))?.serverId, 'live');
    store.fail = false;
    assert.equal((await store.requestClose(record.id, project))?.serverId, 'live');
  } finally { store.fail = false; await store.flushAll(); }
});

function deps(over: Partial<RestoreDeps> = {}): RestoreDeps {
  return {
    readLiveSessions: async () => ({ instanceId: 'instance', serverIds: new Set(live) }),
    listLiveSessions: async () => [],
    createSession: async () => { throw new Error('unexpected relaunch'); },
    killSession: proxyKillSession,
    enqueue: (args) => ({ queued: false, done: args.thunk(args.signal ?? new AbortController().signal) }),
    getTask: async () => null,
    getUserSettings: async () => ({}),
    detectInterruption: async () => ({ interruption: 'unknown', turn: 'unknown', busy: 'unknown', transcriptExists: false }),
    discoverCodexSession: async () => false,
    dirExists: async () => true,
    now: Date.now,
    ...over,
  };
}

test('a requested close blocks explicit restore even while its PTY remains live', async () => {
  const { project, record } = await setup();
  await terminalRegistry.requestClose(record.id, project);
  const pending = await terminalRegistry.get(record.id, project);
  const summary = await restore(project, deps(), { retryFailed: true });
  assert.equal(summary.queued, 0);
  assert.equal(summary.adopted, 0);
  assert.deepEqual(await terminalRegistry.get(record.id, project), pending);
});

test('close during a relaunch preserves the late PTY if cleanup fails, and route retry reclaims it', async () => {
  const { project, record } = await setup({ serverId: undefined, relaunching: true });
  const serverId = `late_${record.id}`;
  const d = deps({
    createSession: async (opts) => {
      await terminalRegistry.requestClose(record.id, project);
      live.add(serverId);
      await recordSpawnedTerminal(opts, undefined, serverId, 'instance', undefined);
      return { id: serverId, terminalId: record.id };
    },
  });
  mode = '503';
  const start = attempts.length;
  await enqueueRelaunch(record, d);
  const pending = await terminalRegistry.get(record.id, project);
  assert.equal(pending?.closePending, true);
  assert.equal(pending?.ended?.reason, 'closed', 'late bookkeeping cannot reopen close intent');
  assert.equal(pending?.serverId, serverId);
  assert.equal(pending?.relaunching, undefined);
  const fresh = new TerminalRegistryStore();
  assert.equal((await fresh.get(record.id, project))?.serverId, serverId, 'late PTY ownership persists before cleanup');
  mode = '200';
  await withApp(async (base) => {
    assert.equal((await close(base, record)).status, 200);
    assert.equal(await terminalRegistry.get(record.id, project), null);
    assert.equal(live.has(serverId), false);
  });
  assert.deepEqual(attempts.slice(start), [serverId, serverId]);
});

test('a queued relaunch observes close intent and declines to spawn before a serverless retry completes', async () => {
  const { project, record } = await setup({ serverId: undefined, relaunching: true });
  await terminalRegistry.requestClose(record.id, project);
  await withApp(async (base) => {
    assert.equal((await close(base, record)).status, 503, 'an unresolved spawn still owns this tombstone');
    await enqueueRelaunch(record, deps());
    assert.equal((await terminalRegistry.get(record.id, project))?.relaunching, undefined);
    assert.equal((await close(base, record)).status, 200);
    assert.equal(await terminalRegistry.get(record.id, project), null);
  });
});
