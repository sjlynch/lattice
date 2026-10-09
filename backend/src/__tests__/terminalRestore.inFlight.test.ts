// Restore while relaunches are in flight: a tab closed mid-relaunch gets its
// new pty killed instead of orphaned (and no restored event); a second restore
// is refused as already-running, so a relaunched tab is never spawned twice and
// a later pass only adopts the landed pty. Harness: helpers/terminalRestore.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { restoreProjectTerminals } from '../terminalRegistry/restore.js';
import { harness, record, settle } from './helpers/terminalRestore.js';

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
