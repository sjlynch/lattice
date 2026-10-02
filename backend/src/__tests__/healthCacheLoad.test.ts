import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HealthCache } from '../health/cache.js';
import { CACHE_VERSION, cacheDir, cachePath } from '../health/cachePaths.js';
import { minimalMetrics } from './helpers/health.js';
import { withTempDir } from './helpers/tempDir.js';

test('HealthCache.load drops malformed entries instead of failing every later scan', async () => {
  await withTempDir('lattice-health-cache-load-', async (root) => {
    const good = path.join(root, 'good.ts');
    const noSmells = path.join(root, 'no-smells.ts');
    const noImports = path.join(root, 'no-imports.ts');
    const nul = path.join(root, 'null.ts');
    const metrics = minimalMetrics({ loc: 3 });
    await fs.mkdir(cacheDir(root), { recursive: true });
    await fs.writeFile(cachePath(root), JSON.stringify({
      version: CACHE_VERSION,
      files: {
        [good]: { mtimeMs: 1, size: 1, metrics, imports: ['./x'] },
        [noSmells]: { mtimeMs: 1, size: 1, metrics: { ...metrics, smells: undefined }, imports: [] },
        [noImports]: { mtimeMs: 1, size: 1, metrics },
        [nul]: null,
      },
    }));
    const cache = new HealthCache(root);
    await cache.load();
    assert.ok(cache.get(good, 1, 1), 'a well-formed entry survives');
    assert.equal(cache.get(noSmells, 1, 1), undefined);
    assert.equal(cache.get(noImports, 1, 1), undefined);
    assert.equal(cache.get(nul, 1, 1), undefined);
    assert.deepEqual([...cache.entries()].map(([f]) => f), [good]);
  });
});

const cacheFileExists = (root: string) => fs.access(cachePath(root)).then(() => true, () => false);

test('HealthCache.set with an identical entry leaves the cache clean', async () => {
  await withTempDir('lattice-health-cache-unchanged-', async (root) => {
    const file = path.join(root, 'a.ts');
    const cache = new HealthCache(root);
    cache.set(file, 1, 1, minimalMetrics({ loc: 3, fanIn: 2 }), ['./x']);
    await cache.flush();
    assert.ok(await cacheFileExists(root), 'a new entry is written');
    await fs.unlink(cachePath(root));
    // Fresh but equal objects, the way a scan re-seeds the watcher's cache. A
    // key holding undefined serializes like an absent one.
    cache.set(file, 1, 1, minimalMetrics({ loc: 3, fanIn: 2, deadCode: undefined }), ['./x']);
    await cache.flush();
    assert.equal(await cacheFileExists(root), false, 'an unchanged entry performs no write');
  });
});

test('HealthCache.set marks a changed stat, metric or import dirty', async () => {
  await withTempDir('lattice-health-cache-changed-', async (root) => {
    const file = path.join(root, 'a.ts');
    const base = () => minimalMetrics({ loc: 3 });
    const changes: Array<[string, (cache: HealthCache) => void]> = [
      ['mtime', (cache) => cache.set(file, 2, 1, base(), ['./x'])],
      ['size', (cache) => cache.set(file, 1, 2, base(), ['./x'])],
      ['metrics', (cache) => cache.set(file, 1, 1, minimalMetrics({ loc: 3, score: 90 }), ['./x'])],
      ['nested metrics', (cache) => cache.set(file, 1, 1, minimalMetrics({
        loc: 3,
        smells: [{ id: 'todo_fixme', count: 1, label: 'TODO / FIXME' }],
      }), ['./x'])],
      ['added metric field', (cache) => cache.set(file, 1, 1, minimalMetrics({ loc: 3, deadCode: 'dead' }), ['./x'])],
      ['imports', (cache) => cache.set(file, 1, 1, base(), ['./x', './y'])],
      ['replaced import', (cache) => cache.set(file, 1, 1, base(), ['./y'])],
    ];
    for (const [what, change] of changes) {
      const cache = new HealthCache(root);
      cache.set(file, 1, 1, base(), ['./x']);
      await cache.flush();
      await fs.unlink(cachePath(root));
      change(cache);
      await cache.flush();
      assert.ok(await cacheFileExists(root), `a changed ${what} is written`);
    }
  });
});
