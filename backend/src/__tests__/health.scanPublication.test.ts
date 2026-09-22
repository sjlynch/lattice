import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { HealthCache } from '../health/cache.js';
import { ScanPublication, type WatcherSlot } from '../health/watcher/scanPublication.js';
import { WatcherRevision } from '../health/watcher/revision.js';
import type { ProjectWatcher } from '../health/watcher/types.js';
import { minimalMetrics } from './helpers/health.js';
import { withTempDir } from './helpers/tempDir.js';

function fixture(root: string) {
  const file = path.join(root, 'a.ts');
  const metric = minimalMetrics({ loc: 10 });
  const revision = new WatcherRevision();
  const proj = {
    root, revision, cache: new HealthCache(root),
    imports: new Map([[file, ['./current']]]),
    metrics: new Map([[file, metric]]),
    crossFile: { invalidateRoots() {} },
  } as unknown as ProjectWatcher;
  proj.cache.set(file, 1, 1, metric, ['./current']);
  let slot: WatcherSlot | undefined = { revision, creation: Promise.resolve(proj) };
  const publisher = new ScanPublication(() => slot);
  const cache = new HealthCache(root);
  const stale = minimalMetrics({ loc: 99 });
  cache.set(file, 1, 1, stale, ['./stale']);
  const payload = [cache, new Map([[file, ['./stale']]]), new Map([[file, stale]])] as const;
  return { file, proj, publisher, payload, setSlot(value: WatcherSlot | undefined) { slot = value; } };
}

test('a file event during a full scan fences both map and cache publication', async () => {
  await withTempDir('lattice-scan-watch-revision-', async (root) => {
    const { file, proj, publisher, payload } = fixture(root);
    const scan = publisher.begin(root);
    const event = proj.revision.begin(file);
    proj.imports.delete(file);
    proj.metrics.delete(file);
    proj.cache.delete(file);
    event.finish();
    assert.equal(await scan.commit(...payload), false);
    scan.finish();
    assert.equal(proj.metrics.has(file), false);
    assert.deepEqual([...proj.cache.entries()], []);
    await proj.cache.flush();
  });
});

test('a scan starting during a pending event cannot seed over its later result', async () => {
  await withTempDir('lattice-scan-watch-pending-', async (root) => {
    const { file, proj, publisher, payload } = fixture(root);
    const event = proj.revision.begin(file);
    const scan = publisher.begin(root);
    event.finish();
    assert.equal(await scan.commit(...payload), false);
    scan.finish();
    assert.equal(proj.metrics.get(file)?.loc, 10);
    await proj.cache.flush();
  });
});

test('watcher creation during a held scan fences the old snapshot', async () => {
  await withTempDir('lattice-scan-watch-created-', async (root) => {
    const { file, proj, publisher, payload, setSlot } = fixture(root);
    setSlot(undefined);
    const scan = publisher.begin(root);
    setSlot({ revision: proj.revision, creation: Promise.resolve(proj) });
    assert.equal(await scan.commit(...payload), false);
    scan.finish();
    assert.equal(proj.metrics.get(file)?.loc, 10);
    await proj.cache.flush();
  });
});

test('watcher revision is rechecked after its pending creation resolves', async () => {
  await withTempDir('lattice-scan-watch-starting-', async (root) => {
    const { file, proj, publisher, payload, setSlot } = fixture(root);
    let resolve!: (proj: ProjectWatcher) => void;
    setSlot({ revision: proj.revision, creation: new Promise((r) => { resolve = r; }) });
    const scan = publisher.begin(root);
    const publishing = scan.commit(...payload);
    proj.revision.begin(file).finish();
    resolve(proj);
    assert.equal(await publishing, false);
    scan.finish();
    assert.equal(proj.metrics.get(file)?.loc, 10);
    await proj.cache.flush();
  });
});

test('a newer completed scan fences older scans and seeds the watcher cache owner', async () => {
  await withTempDir('lattice-scan-watch-latest-', async (root) => {
    const { file, proj, publisher, payload } = fixture(root);
    const old = publisher.begin(root);
    const fresh = publisher.begin(root);
    assert.equal(await fresh.commit(...payload), true);
    fresh.finish();
    assert.equal(await old.commit(new HealthCache(root), new Map(), new Map()), false);
    old.finish();
    assert.equal(proj.metrics.get(file)?.loc, 99);
    await proj.cache.flush();
    const loaded = new HealthCache(root);
    await loaded.load();
    assert.deepEqual(loaded.get(file, 1, 1)?.imports, ['./stale']);
  });
});

test('cache loading waits for a preceding scan flush across cache instances', async () => {
  await withTempDir('lattice-scan-cache-owner-', async (root) => {
    const file = path.join(root, 'a.ts');
    const first = new HealthCache(root);
    first.set(file, 1, 1, minimalMetrics({ loc: 1 }), ['./first']);
    await first.flush();
    const scan = new HealthCache(root);
    scan.set(file, 2, 2, minimalMetrics({ loc: 2 }), ['./scan']);
    const flushing = scan.flush();
    const watcher = new HealthCache(root);
    await watcher.load();
    assert.deepEqual(watcher.get(file, 2, 2)?.imports, ['./scan']);
    await flushing;
    watcher.set(file, 3, 3, minimalMetrics({ loc: 3 }), ['./watcher']);
    await watcher.flush();
    const final = new HealthCache(root);
    await final.load();
    assert.deepEqual(final.get(file, 3, 3)?.imports, ['./watcher']);
  });
});

test('scan cache clones current watcher entries before their debounced save reaches disk', async () => {
  await withTempDir('lattice-scan-cache-clone-', async (root) => {
    const { file, proj, publisher } = fixture(root);
    const staleDisk = new HealthCache(root);
    staleDisk.set(file, 1, 1, minimalMetrics({ loc: 99 }), ['./disk-old']);
    await staleDisk.flush();
    const scan = publisher.begin(root);
    const cache = new HealthCache(root);
    await scan.loadCache(cache);
    const copied = cache.get(file, 1, 1);
    assert.deepEqual(copied?.imports, ['./current']);
    assert.equal(copied?.metrics.loc, 10);
    copied!.metrics.fanIn = 123;
    copied!.imports.push('./scan-only');
    assert.equal(proj.metrics.get(file)?.fanIn, undefined);
    assert.deepEqual(proj.cache.get(file, 1, 1)?.imports, ['./current']);
    scan.finish();
    await proj.cache.flush();
  });
});

test('cancelled scans cannot publish after waiting for watcher creation', async () => {
  await withTempDir('lattice-scan-cache-cancel-', async (root) => {
    const { file, proj, publisher, payload, setSlot } = fixture(root);
    let resolve!: (proj: ProjectWatcher) => void;
    setSlot({ revision: proj.revision, creation: new Promise((r) => { resolve = r; }) });
    let cancelled = false;
    const scan = publisher.begin(root, () => cancelled);
    const publishing = scan.commit(...payload);
    cancelled = true;
    resolve(proj);
    assert.equal(await publishing, false);
    scan.finish();
    assert.equal(proj.metrics.get(file)?.loc, 10);
    await proj.cache.flush();
  });
});

test('a committed scan hands its dead-code root inputs to the watcher', async () => {
  await withTempDir('lattice-scan-watch-roots-', async (root) => {
    const { proj, publisher, payload } = fixture(root);
    const received: unknown[] = [];
    (proj.crossFile as unknown as { setRootInputs: (i: unknown) => void }).setRootInputs = (i) => { received.push(i); };
    const scan = publisher.begin(root);
    const packageRoots = new Set([path.join(root, 'src', 'app.ts')]);
    assert.equal(await scan.commit(...payload, { packageRoots, entryGlobs: ['lib/**'] }), true);
    scan.finish();
    assert.deepEqual(received, [{ packageRoots, entryGlobs: ['lib/**'] }]);
    await proj.cache.flush();
  });
});
