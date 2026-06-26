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

  // Expose the protected write + per-project lock for the BUG 1 / BUG 2 tests.
  write(projectPath: string, state: number[]): Promise<void> {
    return this.writeStateNow(projectPath, state);
  }

  locked<T>(projectPath: string, fn: () => T | Promise<T>): Promise<T> {
    return this.runProjectWrite(projectPath, fn);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// ---------- BUG 1: atomic writes + corrupt-load guard ----------
//
// The debounced persist (100ms) fires constantly while the dev backend is
// frequently killed/restarted (tsc -w). A kill/power-loss mid-write used to
// truncate tasks.json; on next boot performLoad's JSON.parse threw and was
// swallowed identically to "file missing" → loaded [] → the next write of any
// kind persisted the empty list over the still-recoverable corrupt file,
// making the loss permanent and silent. The fix: atomic temp→rename writes
// (a crash can't truncate the live file) and a load path that distinguishes
// ENOENT (legit empty) from a parse failure (preserve the bytes, never default).

test('ENOENT loads the default state without creating a .corrupt-* sidecar', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-psm-'));
  const missing = path.join(dir, 'state.json');
  const store = new TestStore(missing);

  assert.deepEqual(await store.read('/tmp/p'), []);
  const entries = await fs.readdir(dir);
  assert.equal(
    entries.filter((e) => e.includes('.corrupt-')).length,
    0,
    'a genuinely-missing file must not be treated as corruption',
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test('a truncated/corrupt file is preserved and never silently replaced by the default', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-psm-'));
  const file = path.join(dir, 'state.json');
  // Exactly what a kill mid-persist leaves behind: valid JSON, then truncated.
  const truncated = '[{"id":"a"},{"id":"b","v';
  await fs.writeFile(file, truncated, 'utf8');
  const store = new TestStore(file);

  // Load must NOT throw and must fall back to empty in memory...
  assert.deepEqual(await store.read('C:/proj'), []);

  // ...but the original bytes must be preserved in a `.corrupt-*` sidecar and
  // the bad file moved aside, so a later write can't clobber the recoverable
  // data with [].
  const corruptAfterLoad = (await fs.readdir(dir)).filter((e) =>
    e.includes('.corrupt-'),
  );
  assert.equal(corruptAfterLoad.length, 1, 'expected one .corrupt-* sidecar');
  assert.equal(
    await fs.readFile(path.join(dir, corruptAfterLoad[0]), 'utf8'),
    truncated,
    'the original truncated bytes must be preserved verbatim',
  );

  // Now mutate (the next write of any kind). The loader must not have left the
  // data exposed to a silent []-overwrite: the live file holds the new state,
  // and the original bytes are still safe in the sidecar.
  await store.write('C:/proj', [1, 2, 3]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [1, 2, 3]);
  assert.equal(
    await fs.readFile(path.join(dir, corruptAfterLoad[0]), 'utf8'),
    truncated,
    'the corrupt sidecar must survive the subsequent write',
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test('writeStateNow is atomic (temp→rename) and leaves no temp orphan', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-psm-'));
  const file = path.join(dir, 'state.json');
  const store = new TestStore(file);

  await store.write('C:/p', [9, 8, 7]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [9, 8, 7]);
  const leftovers = (await fs.readdir(dir)).filter((e) => e.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, 'no temp file should survive a successful write');

  await fs.rm(dir, { recursive: true, force: true });
});

// ---------- BUG 2: per-project write lock (base primitive) ----------

test('runProjectWrite serializes same-project writers but lets different projects overlap', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-psm-'));
  const store = new TestStore(path.join(dir, 'state.json'));

  // Same project: the slow A must fully settle before the fast B starts — no
  // interleaving of one project's read-modify-writes.
  const order: string[] = [];
  await Promise.all([
    store.locked('C:/same', async () => {
      order.push('A:start');
      await sleep(25);
      order.push('A:end');
    }),
    store.locked('C:/same', async () => {
      order.push('B:start');
      order.push('B:end');
    }),
  ]);
  assert.deepEqual(order, ['A:start', 'A:end', 'B:start', 'B:end']);

  // Different projects: both enter before either finishes (no cross-key block).
  const order2: string[] = [];
  await Promise.all([
    store.locked('C:/p1', async () => {
      order2.push('p1:start');
      await sleep(20);
    }),
    store.locked('C:/p2', async () => {
      order2.push('p2:start');
      await sleep(20);
    }),
  ]);
  assert.deepEqual(order2.sort(), ['p1:start', 'p2:start']);

  await fs.rm(dir, { recursive: true, force: true });
});
