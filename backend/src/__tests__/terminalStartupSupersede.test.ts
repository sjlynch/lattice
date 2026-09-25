import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalRegistryStore } from '../terminalRegistry/store.js';
import { endSupersededStartupRecords } from '../terminalRegistry/startupSupersede.js';
import type { TerminalRecord, TerminalRegistryEvent } from '../terminalRegistry/types.js';

// Regression: with `restoreTerminalsOnOpen: 'never'` the restore pass never
// runs, so a dead startup record from a replaced executor was never ended and
// every restart left another dead "session lost" `npm run dev` tab beside the
// re-seeded one.

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-termreg-sup-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-termreg-sup-proj-'));
  const store = new TerminalRegistryStore({
    fileForProject: () => path.join(dir, 'terminals.json'),
    listKnownProjects: async () => [project],
  });
  const events: TerminalRegistryEvent[] = [];
  store.subscribe((e) => events.push(e));
  return { store, project, events };
}

const startup = (project: string, over: Partial<TerminalRecord> = {}) => ({
  projectPath: project,
  cwd: project,
  label: 'npm run dev',
  owner: 'startup' as const,
  kind: 'startup' as const,
  startupId: 'dev',
  launch: { initialCommand: 'npm run dev' },
  serverId: 'tty_old',
  serverInstanceId: 'inst-A',
  ...over,
});

test('a re-seeded startup terminal ends its dead predecessor from a replaced executor', async () => {
  const { store, project, events } = await makeStore();
  const old = await store.create(startup(project));
  const fresh = await store.create(startup(project, { serverId: 'tty_new', serverInstanceId: 'inst-B' }));

  assert.equal(await endSupersededStartupRecords(store, fresh, 'inst-B'), 1);

  const tabs = (await store.list(project)).filter((r) => r.owner === 'startup');
  assert.deepEqual(tabs.map((r) => r.id), [fresh.id]);
  const ended = events.find((e) => e.type === 'ended' && e.id === old.id);
  assert.ok(ended && ended.type === 'ended');
  assert.equal(ended.ended.reason, 'owner-finished');
});

test('repeated executor restarts never accumulate startup tabs', async () => {
  const { store, project } = await makeStore();
  let prev = await store.create(startup(project, { serverId: 'tty_0', serverInstanceId: 'inst-0' }));
  for (let i = 1; i <= 3; i++) {
    const inst = `inst-${i}`;
    prev = await store.create(startup(project, { serverId: `tty_${i}`, serverInstanceId: inst }));
    await endSupersededStartupRecords(store, prev, inst);
  }
  const tabs = (await store.list(project)).filter((r) => r.owner === 'startup');
  assert.deepEqual(tabs.map((r) => r.id), [prev.id]);
});

test('leaves same-instance, other-startup and non-startup records alone', async () => {
  const { store, project } = await makeStore();
  // Same executor instance: its pty may still be alive — the exit watcher decides.
  const sameInstance = await store.create(startup(project, { serverId: 'tty_live', serverInstanceId: 'inst-B' }));
  // A different startup command.
  const other = await store.create(startup(project, { startupId: 'watch', label: 'npm run watch' }));
  // A user tab from the old executor (restore's to handle, not this).
  const user = await store.create({
    projectPath: project,
    cwd: project,
    label: 'claude',
    owner: 'user',
    launch: { initialCommand: 'claude', harness: 'claude' },
    serverId: 'tty_user',
    serverInstanceId: 'inst-A',
  });
  const fresh = await store.create(startup(project, { serverId: 'tty_new', serverInstanceId: 'inst-B' }));

  assert.equal(await endSupersededStartupRecords(store, fresh, 'inst-B'), 0);
  const ids = (await store.list(project)).map((r) => r.id).sort();
  assert.deepEqual(ids, [sameInstance.id, other.id, user.id, fresh.id].sort());
});

test('an unknown current executor instance only ends records with no pty', async () => {
  const { store, project } = await makeStore();
  const withPty = await store.create(startup(project));
  const noPty = await store.create(startup(project, { serverId: undefined }));
  const fresh = await store.create(startup(project, { serverId: 'tty_new', serverInstanceId: undefined }));

  assert.equal(await endSupersededStartupRecords(store, fresh, undefined), 1);
  const ids = (await store.list(project)).map((r) => r.id).sort();
  assert.deepEqual(ids, [withPty.id, fresh.id].sort());
  assert.ok(!ids.includes(noPty.id));
});
