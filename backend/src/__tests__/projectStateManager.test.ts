import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ProjectStateManager } from '../projectStateManager.js';

// Regression coverage for the "marked loaded before the cache is populated"
// race. `loadIfNeeded` used to flip its `loaded` flag true *before* awaiting
// the disk read, so a second caller arriving during that await fell straight
// through to an empty cache (transient empty board / task-not-found). The fix
// caches the in-flight load PROMISE and only flips `loaded` once the read has
// actually populated the cache.

// Concrete subclass that exposes the protected load/read surface and counts
// how many times an actual load body runs (so we can assert single-flight).
class TestStore extends ProjectStateManager<number[]> {
  public reads = 0;

  constructor(file: string) {
    super({
      name: 'test',
      fileForProject: () => {
        this.reads += 1;
        return file;
      },
      defaultState: () => [],
      deserialize: (raw) => (Array.isArray(raw) ? (raw as number[]) : []),
    });
  }

  // Mirrors the real read path (manager.listTasks): resolve the load, then
  // synchronously read the cache. A premature `loaded` flag surfaces here as
  // an empty list.
  async read(projectPath: string): Promise<number[]> {
    const key = await this.loadIfNeeded(projectPath);
    return [...(this.getCached(key) ?? [])];
  }

  loadedNow(projectPath: string): boolean {
    return this.isLoaded(projectPath);
  }
}

async function tmpFile(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-psm-'));
  const file = path.join(dir, 'state.json');
  await fs.writeFile(file, contents, 'utf8');
  return file;
}

test('two concurrent reads against a cold project both see the full list', async () => {
  const file = await tmpFile(JSON.stringify([1, 2, 3, 4, 5]));
  const store = new TestStore(file);
  const project = 'C:/some/project';

  // Issue both reads before either load resolves — the racing second caller
  // must wait for the in-flight load, not observe an empty cache.
  const [a, b] = await Promise.all([store.read(project), store.read(project)]);

  assert.deepEqual(a, [1, 2, 3, 4, 5]);
  assert.deepEqual(b, [1, 2, 3, 4, 5]);

  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test('concurrent loads are single-flight: the disk read runs exactly once', async () => {
  const file = await tmpFile(JSON.stringify([10, 20]));
  const store = new TestStore(file);
  const project = '/tmp/cold-project';

  await Promise.all([
    store.read(project),
    store.read(project),
    store.read(project),
  ]);

  assert.equal(store.reads, 1, 'expected a single load for concurrent reads');
  // A later read after the load resolved must not re-read either.
  await store.read(project);
  assert.equal(store.reads, 1, 'a settled load must not re-read on later access');

  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test('loaded flag is not set until the cache is populated', async () => {
  const file = await tmpFile(JSON.stringify([7]));
  const store = new TestStore(file);
  const project = '/tmp/another-project';

  // Synchronously: kick off the load, then check the flag before awaiting.
  const pending = store.read(project);
  assert.equal(
    store.loadedNow(project),
    false,
    'must not report loaded while the read is still in flight',
  );
  const result = await pending;
  assert.deepEqual(result, [7]);
  assert.equal(store.loadedNow(project), true);

  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test('a missing state file resolves to the default state for all racers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-psm-'));
  const missing = path.join(dir, 'does-not-exist.json');
  const store = new TestStore(missing);
  const project = '/tmp/empty-project';

  const [a, b] = await Promise.all([store.read(project), store.read(project)]);
  assert.deepEqual(a, []);
  assert.deepEqual(b, []);

  await fs.rm(dir, { recursive: true, force: true });
});
