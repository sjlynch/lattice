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
