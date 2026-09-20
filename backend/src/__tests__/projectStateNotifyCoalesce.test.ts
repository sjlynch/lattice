import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStateManager, flushProjectNotifications } from '../projectStateManager.js';

// notifyProject is coalesced per project key and delivered a turn later: N
// mutations in one turn (a bulk transition, a merge run flipping tasks) fan out
// ONE snapshot, taken from the cache at delivery time. Every such fan-out used
// to serialize and push the whole board to every WS client per task.

class Counter extends ProjectStateManager<number> {
  constructor(dir: string) {
    super({
      name: 'counter-test',
      fileForProject: (p) => path.join(dir, `${Buffer.from(p).toString('hex')}.json`),
      defaultState: () => 0,
    });
  }
  bump(project: string): void {
    this.setCached(project, (this.getCached(project) ?? 0) + 1);
    this.notifyProject(project);
  }
}

test('N notifyProject calls in one turn deliver one fan-out carrying the latest state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-notify-'));
  const projectA = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-notify-a-'));
  const projectB = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-notify-b-'));
  try {
    const store = new Counter(dir);
    const seen: Array<[string, number]> = [];
    store.subscribe((p, state) => seen.push([p, state]));

    for (let i = 0; i < 200; i++) store.bump(projectA);
    store.bump(projectB);
    assert.equal(seen.length, 0, 'delivery is deferred past the mutating turn');

    await flushProjectNotifications();
    assert.equal(seen.length, 2, 'one fan-out per project key');
    const a = seen.find(([p]) => p.toLowerCase().includes(path.basename(projectA).toLowerCase()));
    assert.equal(a?.[1], 200, 'the snapshot is the state at delivery, not at the first call');

    // A later turn is a new batch.
    store.bump(projectA);
    await flushProjectNotifications();
    assert.equal(seen.length, 3);
    assert.equal(seen[2]![1], 201);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(projectA, { recursive: true, force: true });
    await fs.rm(projectB, { recursive: true, force: true });
  }
});

test('a subscriber that throws does not stop the fan-out to the others', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-notify-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-notify-p-'));
  const origError = console.error;
  console.error = () => {};
  try {
    const store = new Counter(dir);
    let delivered = 0;
    store.subscribe(() => { throw new Error('boom'); });
    store.subscribe(() => { delivered += 1; });
    store.bump(project);
    await flushProjectNotifications();
    assert.equal(delivered, 1);
  } finally {
    console.error = origError;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(project, { recursive: true, force: true });
  }
});
