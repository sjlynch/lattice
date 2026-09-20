import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TerminalRegistryStore,
  deserializeTerminalRecords,
} from '../terminalRegistry/store.js';
import type { TerminalRecord, TerminalRegistryEvent } from '../terminalRegistry/types.js';

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-termreg-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-termreg-proj-'));
  const file = path.join(dir, 'terminals.json');
  const store = new TerminalRegistryStore({
    fileForProject: () => file,
    listKnownProjects: async () => [project],
  });
  const events: TerminalRegistryEvent[] = [];
  store.subscribe((e) => events.push(e));
  return { store, file, project, events };
}

const base = (project: string, over: Partial<TerminalRecord> = {}) => ({
  projectPath: project,
  cwd: project,
  label: 'claude 1',
  owner: 'user' as const,
  launch: { initialCommand: 'claude', harness: 'claude' as const },
  serverId: 'tty_1',
  serverInstanceId: 'inst-A',
  ...over,
});

test('create / list / update / reorder persist through the versioned file', async () => {
  const { store, file, project, events } = await makeStore();
  const a = await store.create(base(project));
  const b = await store.create(base(project, { label: 'pi 2', serverId: 'tty_2' }));
  assert.equal(a.order, 0);
  assert.equal(b.order, 1);
  assert.equal(events.filter((e) => e.type === 'upsert').length, 2);

  await store.update(a.id, { label: 'renamed' }, project);
  await store.reorder(project, [b.id, a.id]);
  await store.flushPersist(project);

  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { version: number; terminals: unknown[] };
  assert.equal(raw.version, 1);
  const again = deserializeTerminalRecords(raw)!;
  assert.deepEqual(again.map((r) => [r.id, r.label, r.order]), [[b.id, 'pi 2', 0], [a.id, 'renamed', 1]]);

  // A fresh store reads the same thing back.
  const store2 = new TerminalRegistryStore({ fileForProject: () => file, listKnownProjects: async () => [project] });
  const list = await store2.list(project);
  assert.deepEqual(list.map((r) => r.id), [b.id, a.id]);
});

test('ending a tab removes it (closed / exit / owner-finished) but keeps restore failures', async () => {
  const { store, project, events } = await makeStore();
  const a = await store.create(base(project));
  const b = await store.create(base(project, { serverId: 'tty_2' }));
  const c = await store.create(base(project, { serverId: 'tty_3' }));
  await store.end(a.id, { reason: 'closed' }, project);
  await store.end(b.id, { reason: 'restore-failed', detail: 'boom' }, project);
  await store.end(c.id, { reason: 'cwd-missing' }, project);
  assert.deepEqual((await store.list(project)).map((r) => r.id), []);
  const all = await store.list(project, { includeEnded: true });
  assert.deepEqual(all.map((r) => [r.id, r.ended?.reason, r.serverId]), [
    [b.id, 'restore-failed', undefined],
    [c.id, 'cwd-missing', undefined],
  ]);
  assert.ok(events.some((e) => e.type === 'removed' && e.id === a.id));
  assert.ok(events.some((e) => e.type === 'ended' && e.id === b.id && e.ended.detail === 'boom'));
  assert.equal(events.some((e) => e.type === 'removed' && e.id === b.id), false);
});

test('endWhere ends only matching loaded records; noteBusy stamps transitions once', async () => {
  const { store, project } = await makeStore();
  const a = await store.create(base(project, { cwd: path.join(project, 'wt') }));
  const b = await store.create(base(project, { serverId: 'tty_2' }));
  const n = await store.endWhere((r) => r.serverId === 'tty_2', { reason: 'killed' });
  assert.equal(n, 1);
  assert.deepEqual((await store.list(project)).map((r) => r.id), [a.id]);
  assert.equal(b.id !== a.id, true);

  await store.noteBusy(new Set(['tty_1']), 100);
  await store.noteBusy(new Set(['tty_1']), 200); // no change → no re-stamp
  assert.deepEqual((await store.get(a.id, project))?.lastBusy, { busy: true, at: 100 });
  await store.noteBusy(new Set(), 300);
  assert.deepEqual((await store.get(a.id, project))?.lastBusy, { busy: false, at: 300 });
});

test('deserialize drops malformed records and prunes long-ended ones', () => {
  const now = Date.now();
  const good = { id: 'x', projectPath: 'p', cwd: 'c', owner: 'user', launch: {}, label: 'l', order: 0 };
  const out = deserializeTerminalRecords({
    version: 1,
    terminals: [
      good,
      { ...good, id: 'y', owner: 'bogus' },
      { ...good, id: 'z', ended: { at: now - 30 * 24 * 3600 * 1000, reason: 'restore-failed' } },
      { ...good, id: 'w', ended: { at: now, reason: 'cwd-missing' } },
      'junk',
      { ...good, id: 'v', agentSession: { harness: 'pi', id: 'lattice-1', source: 'minted' } },
    ],
  })!;
  assert.deepEqual(out.map((r) => r.id), ['x', 'w', 'v']);
  assert.deepEqual(out[2]!.agentSession, { harness: 'pi', id: 'lattice-1', source: 'minted' });
  assert.equal(deserializeTerminalRecords({ nope: true }), null);
});

test('get() without a project falls back to loading every known project', async () => {
  const { store, project } = await makeStore();
  const a = await store.create(base(project));
  const store2 = new TerminalRegistryStore({
    fileForProject: () => path.join(path.dirname((await0(store)).file), 'terminals.json'),
    listKnownProjects: async () => [project],
  });
  await store.flushPersist(project);
  const found = await store2.get(a.id);
  assert.equal(found?.id, a.id);
});

// Small helper so the test above can reach the temp file path through the
// store instance's private-ish config; kept local to this file.
function await0(store: TerminalRegistryStore): { file: string } {
  const fileFor = (store as unknown as { fileForProject: (p: string) => string }).fileForProject;
  return { file: fileFor('') };
}
