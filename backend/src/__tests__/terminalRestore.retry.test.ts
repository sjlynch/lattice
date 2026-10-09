// Failed relaunches and the explicit retry: a restore-failed tab is left alone
// by the on-open pass and retried only on request, a retry that fails again
// keeping the ORIGINAL failure time (the retention clock); a retried tab whose
// pty actually landed is adopted, not spawned beside, and projected as a live
// tab (no failure reason, no busy evidence from the dead pty) by the restored
// and upsert events, the HTTP/WS lists and after a backend restart; a failed
// record already naming its live pty is reconciled before adoption, keeping
// its learned identity; an orphan pty owned by an excluded failed record is
// never stolen. Harness: helpers/terminalRestore.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalRegistry, TerminalRegistryStore } from '../terminalRegistry/store.js';
import { restoreProjectTerminals } from '../terminalRegistry/restore.js';
import { harness, record, settle } from './helpers/terminalRestore.js';

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
  const r = await record(h, {
    serverId: undefined, serverInstanceId: undefined, relaunching: true,
    lastBusy: { busy: true, at: Date.now() - 60_000 },
  });
  await terminalRegistry.end(r.id, { reason: 'restore-failed', detail: 'bookkeeping blew up' }, h.project);
  h.live.ids = ['tty_landed'];
  h.live.sessions = [{ id: 'tty_landed', cwd: h.project, initialCommand: 'claude --resume S1' }];
  const summary = await restoreProjectTerminals(h.project, h.deps, { retryFailed: true });
  await settle();
  assert.equal(summary.adopted, 1);
  assert.equal(h.spawns.length, 0);
  const after = (await terminalRegistry.get(r.id, h.project))!;
  assert.equal(after.serverId, 'tty_landed');
  assert.equal(after.serverInstanceId, h.live.instanceId);
  assert.equal(after.ended, undefined);
  assert.equal(after.relaunching, undefined);
  assert.equal(after.lastBusy, undefined, 'the dead pty cannot supply busy evidence for its replacement');
  const restored = h.events.find((e) => e.type === 'restored' && e.record.id === r.id);
  assert.ok(restored?.type === 'restored');
  assert.deepEqual(restored.record, after, 'restored announces the committed live record');
  const upsert = h.events.find((e) => e.type === 'upsert' && e.record.serverId === 'tty_landed');
  assert.ok(upsert?.type === 'upsert');
  assert.deepEqual(upsert.record, after, 'upsert also projects a live tab, without a failure reason');
  // HTTP fetch and WS hello include ended records. Neither may project this
  // live tab back to restore=failed, including after a backend restart.
  await terminalRegistry.flushPersist(h.project);
  const reloaded = new TerminalRegistryStore();
  assert.deepEqual(await reloaded.list(h.project, { includeEnded: true }), [after]);
  assert.deepEqual(await terminalRegistry.list(h.project), [after]);
  await terminalRegistry.noteBusy(new Set(['tty_landed']), Date.now());
  assert.equal((await terminalRegistry.get(r.id, h.project))?.lastBusy?.busy, true);
  const again = await restoreProjectTerminals(h.project, h.deps);
  assert.equal(again.adopted, 1, 'the on-open pass still sees the adopted record');
  assert.equal(again.queued, 0);
  assert.equal(h.spawns.length, 0);
  assert.deepEqual(h.kills, []);
});

test('a retryable failed record already naming its live pty is reconciled before adoption', async () => {
  const h = await harness();
  const r = await record(h, {
    serverId: 'tty_live', serverInstanceId: 'inst-A', relaunching: true,
    ended: { reason: 'restore-failed', detail: 'late bookkeeping failure', at: Date.now() },
  });
  h.live.ids = ['tty_live'];
  const summary = await restoreProjectTerminals(h.project, h.deps, { retryFailed: true });
  await settle();
  assert.equal(summary.adopted, 1);
  const after = (await terminalRegistry.list(h.project, { includeEnded: true }))[0]!;
  assert.equal(after.id, r.id);
  assert.equal(after.serverInstanceId, h.live.instanceId);
  assert.equal(after.ended, undefined);
  assert.equal(after.relaunching, undefined);
  assert.deepEqual(after.agentSession, r.agentSession, 'the same live pty keeps its learned identity');
  assert.ok(h.events.some((e) => e.type === 'restored' && e.record.id === r.id
    && !e.record.ended && !e.record.relaunching));
  assert.equal((await restoreProjectTerminals(h.project, h.deps)).adopted, 1);
  assert.equal(h.spawns.length, 0);
});

test('an orphan candidate owned by an excluded failed record is never stolen', async () => {
  const h = await harness();
  const owner = await record(h, {
    serverId: 'tty_owned', serverInstanceId: h.live.instanceId,
    ended: { reason: 'restore-failed', at: Date.now() },
  });
  const dead = await record(h, {});
  h.live.ids = ['tty_owned'];
  h.live.sessions = [{ id: 'tty_owned', cwd: h.project, initialCommand: 'claude --resume S1' }];
  const summary = await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(summary.adopted, 0);
  assert.deepEqual(summary.relaunchedIds, [dead.id]);
  assert.deepEqual(await terminalRegistry.get(owner.id, h.project), owner);
  assert.deepEqual(h.kills, []);
});
