// Codex orphan adoption against real rollout files (`session_meta.timestamp`
// is the process start; the rollout file itself appears only on the first
// turn). An adopted orphan without an explicit id replaces the dead tab's
// identity rather than inheriting it — neither the tab's creation nor the
// adoption time can pin the new process, and the old rollout alone cannot
// re-pin it — then discovers its own thread; the discovery window survives a
// backend restart and the next restart resumes the new thread, never the old.
// An explicit id in the orphan's command is kept and a peer's pty never taken;
// an undiscovered adopted tab keeps its creation floor but refreshes its write
// window on relaunch; a scan that started before adoption cannot put the dead
// pty's identity back. Harness: helpers/terminalRestoreTranscripts.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { terminalRegistry, TerminalRegistryStore } from '../terminalRegistry/store.js';
import { restoreProjectTerminals } from '../terminalRegistry/restore.js';
import { discoverCodexSessionFor, resetCodexDiscoveryCaches } from '../terminalRegistry/codexDiscovery.js';
import type { TerminalLaunch } from '../terminalRegistry/types.js';
import { deadTab, harness, settle, writeCodexRollout } from './helpers/terminalRestoreTranscripts.js';

for (const command of ['codex --yolo', 'codex resume --last --yolo', 'codex resume --last --yolo continue']) {
  test(`codex orphan (${command}) replaces the dead identity and discovers its own thread`, async (t) => {
    resetCodexDiscoveryCaches();
    const h = await harness();
    const now = Date.now();
    const resumed = command.includes('resume');
    const oldStartedAt = now - 20 * 60_000;
    const orphanStartedAt = now - 5 * 60_000;
    // The tab predates its replacement process; adoption happens long after
    // that process started. Neither tab.createdAt nor adoption time can pin B.
    const clock = t.mock.method(Date, 'now', () => oldStartedAt);
    const r = await deadTab(h, { initialCommand: 'codex --yolo', harness: 'codex' }, {
      harness: 'codex', id: 'thread-A', source: 'rollout-scan',
    });
    clock.mock.restore();
    t.after(async () => { await terminalRegistry.remove(r.id, h.project); });
    await terminalRegistry.update(r.id, { restoredAt: oldStartedAt + 60_000, restoreCount: 2 }, h.project);
    const oldFile = await writeCodexRollout(h.project, 'thread-A', oldStartedAt + 1_000);
    // For a fresh orphan even a recently touched A must be excluded by the
    // new process's creation floor; a resumed orphan uses the write floor.
    const oldWrite = new Date(resumed ? oldStartedAt + 2 * 60_000 : now);
    await fs.utimes(oldFile, oldWrite, oldWrite);
    h.live.ids = ['tty_orphan'];
    h.live.sessions = [{ id: 'tty_orphan', cwd: h.project, initialCommand: command, createdAt: orphanStartedAt }];
    const summary = await restoreProjectTerminals(h.project, h.deps);
    assert.equal(summary.adopted, 1);
    assert.equal(summary.queued, 0);
    assert.equal(h.spawns.length, 0);
    const adopted = (await terminalRegistry.get(r.id, h.project))!;
    assert.equal(adopted.agentSession, undefined, 'unknown must replace A, not inherit it');
    assert.equal(adopted.createdAt, r.createdAt, 'tab history is unchanged');
    assert.equal(adopted.restoreCount, 2);
    assert.equal(adopted.codexDiscovery?.writtenSince, orphanStartedAt);
    assert.equal(await discoverCodexSessionFor(r.id, h.project), false, 'the old rollout alone cannot re-pin A');

    // Persisted provenance survives a backend restart before discovery lands.
    await terminalRegistry.flushPersist(h.project);
    const reloaded = await new TerminalRegistryStore().get(r.id, h.project);
    assert.deepEqual(reloaded?.codexDiscovery, adopted.codexDiscovery);
    assert.equal(reloaded?.agentSession, undefined);

    // --last can resume a thread in an older day directory, even one from
    // before this tab was created. A fresh process uses its own start window.
    await writeCodexRollout(h.project, 'thread-B', resumed ? now - 2 * 86_400_000 : orphanStartedAt + 1_000);
    resetCodexDiscoveryCaches();
    assert.equal(await discoverCodexSessionFor(r.id, h.project), true);
    const discovered = (await terminalRegistry.get(r.id, h.project))!;
    assert.equal(discovered.agentSession?.id, 'thread-B');
    assert.equal(discovered.agentSession?.source, 'rollout-scan');

    // The NEXT executor restart must issue resume B, never resume A.
    h.live.ids = [];
    h.live.sessions = [];
    h.deps.readLiveSessions = async () => ({ instanceId: 'inst-C', serverIds: new Set() });
    await restoreProjectTerminals(h.project, h.deps);
    await settle(h.spawns);
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0].initialCommand, 'codex resume thread-B --yolo');
    assert.equal((await terminalRegistry.get(r.id, h.project))?.agentSession?.id, 'thread-B');
  });
}

test('codex orphan with an explicit id preserves that id and never takes a peer pty', async () => {
  const h = await harness();
  const launch: TerminalLaunch = { initialCommand: 'codex --yolo', harness: 'codex' };
  const r = await deadTab(h, launch, { harness: 'codex', id: 'thread-A', source: 'rollout-scan' });
  const peer = await deadTab(h, launch, { harness: 'codex', id: 'peer-thread', source: 'rollout-scan' });
  await terminalRegistry.update(peer.id, { serverId: 'tty_peer', serverInstanceId: 'inst-B' }, h.project);
  h.live.ids = ['tty_peer', 'tty_orphan'];
  h.live.sessions = [
    { id: 'tty_peer', cwd: h.project, initialCommand: 'codex resume peer-thread' },
    { id: 'tty_orphan', cwd: h.project, initialCommand: 'codex resume "thread-B" --yolo' },
  ];
  const summary = await restoreProjectTerminals(h.project, h.deps);
  assert.equal(summary.adopted, 2);
  assert.equal(h.spawns.length, 0);
  const adopted = (await terminalRegistry.get(r.id, h.project))!;
  assert.equal(adopted.serverId, 'tty_orphan');
  assert.deepEqual(adopted.agentSession, { harness: 'codex', id: 'thread-B', source: 'command' });
  assert.equal(adopted.codexDiscovery, undefined);
  assert.equal((await terminalRegistry.get(peer.id, h.project))?.serverId, 'tty_peer');
  assert.deepEqual((await terminalRegistry.get(peer.id, h.project))?.agentSession, peer.agentSession);
});

test('an undiscovered adopted Codex tab keeps its creation floor but refreshes the write window on relaunch', async (t) => {
  const h = await harness();
  const r = await deadTab(h, { initialCommand: 'codex --yolo', harness: 'codex' });
  t.after(async () => { await terminalRegistry.remove(r.id, h.project); });
  const startedAt = Date.now() - 5 * 60_000;
  h.live.ids = ['tty_orphan'];
  h.live.sessions = [{ id: 'tty_orphan', cwd: h.project, initialCommand: 'codex', createdAt: startedAt }];
  await restoreProjectTerminals(h.project, h.deps);
  h.live.ids = [];
  h.live.sessions = [];
  h.deps.readLiveSessions = async () => ({ instanceId: 'inst-C', serverIds: new Set() });
  await restoreProjectTerminals(h.project, h.deps);
  await settle(h.spawns);
  assert.equal(h.spawns[0].initialCommand, 'codex resume --last --yolo');
  const after = (await terminalRegistry.get(r.id, h.project))!;
  assert.deepEqual(after.codexDiscovery, { createdSince: startedAt, writtenSince: after.restoredAt, mode: 'resumed' });
  assert.deepEqual(after.launch, r.launch);
});

test('a Codex scan that started before adoption cannot put the dead pty identity back', async (t) => {
  resetCodexDiscoveryCaches();
  const h = await harness();
  const r = await deadTab(h, { initialCommand: 'codex', harness: 'codex' });
  t.after(async () => { await terminalRegistry.remove(r.id, h.project); });
  await writeCodexRollout(h.project, 'thread-before-adoption', r.createdAt + 1_000);
  const get = terminalRegistry.get.bind(terminalRegistry);
  let reads = 0;
  const getter = t.mock.method(terminalRegistry, 'get', async (id: string, project?: string) => {
    // Commit the adoption after discovery has read the old rollout, before
    // it publishes its answer. Its captured process no longer owns this tab.
    if (id === r.id && ++reads === 2) {
      await terminalRegistry.update(id, {
        serverId: 'tty_replacement', agentSession: undefined,
        codexDiscovery: { createdSince: r.createdAt + 60_000, writtenSince: r.createdAt + 60_000, mode: 'fresh' },
      }, h.project);
    }
    return get(id, project);
  });
  assert.equal(await discoverCodexSessionFor(r.id, h.project), false);
  getter.mock.restore();
  assert.equal((await terminalRegistry.get(r.id, h.project))?.agentSession, undefined);
});
