// Watcher-facing cache plumbing: cache→graph hydration and the change-event
// forced re-analysis. Split out of the original health.test.ts; uses the shared
// `withTempDir` / metric fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HealthMetrics } from '../health/index.js';
import type { CacheEntry } from '../health/cache.js';
import { hydrateWatcherState } from '../health/watcher/cacheHydration.js';
import { loadOrAnalyzeFile } from '../health/watcher/fileAnalysis.js';
import type { ProjectWatcher } from '../health/watcher/types.js';
import { minimalMetrics } from './helpers/health.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

test('watcher cache hydration keeps imports and metrics mirrors aligned', () => {
  const filePath = path.resolve('health-watch-cache', 'a.ts');
  const metrics = minimalMetrics({ loc: 12, fanIn: 3, fanOut: 1 });
  const entry: CacheEntry = { mtimeMs: 1, size: 2, metrics, imports: ['./b'] };
  const cache = {
    *entries(): IterableIterator<[string, CacheEntry]> {
      yield [filePath, entry];
    },
  };

  const hydrated = hydrateWatcherState(cache);
  assert.deepEqual(hydrated.imports.get(filePath), ['./b']);
  assert.equal(hydrated.metrics.get(filePath), metrics);
});

// A (mtime,size)-keyed cache can collide on a same-size in-place edit whose
// mtimeMs resolves to the cached value (whole-second mtime quantization +
// chokidar awaitWriteFinish). A 'change' event is proof of a write, so it must
// re-analyze rather than serve the stale cached metrics/imports — otherwise the
// D/H/Z overlays and dead-code signal lag the file's real content.
test('change event re-analyzes despite a matching (mtime,size) cache entry', async () => {
  await withTempDir('lattice-health-stale-', async (dir) => {
    // The real, current content imports './real'. A same-size edit (the failure
    // mode) leaves stat.size unchanged, so the cache key still matches.
    await writeLayout(dir, { 'edited.ts': "import { a } from './real';\nexport const x = a;\n" });
    const filePath = path.join(dir, 'edited.ts');
    const stat = await fs.stat(filePath);

    // Seed the cache with STALE metrics/imports under the file's *current*
    // (mtime,size) — exactly the collision the bug exploited.
    const stale = new Map<string, CacheEntry>();
    const cache = {
      get(p: string, mtimeMs: number, size: number) {
        const e = stale.get(p);
        if (!e || e.mtimeMs !== mtimeMs || e.size !== size) return undefined;
        return { metrics: e.metrics, imports: e.imports };
      },
      set(p: string, mtimeMs: number, size: number, metrics: HealthMetrics, imports: string[]) {
        stale.set(p, { mtimeMs, size, metrics, imports });
      },
      save() { /* no-op in test */ },
    };
    const seed = () => {
      stale.set(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        metrics: minimalMetrics({ loc: 999 }),
        imports: ['./stale'],
      });
    };
    const proj = { cache } as unknown as ProjectWatcher;

    // 'add'/initial path (no forceReanalyze) trusts the matching cache entry —
    // confirms the (mtime,size) key genuinely matches here.
    seed();
    const fromCache = await loadOrAnalyzeFile(proj, filePath, '.ts');
    assert.deepEqual(fromCache?.imports, ['./stale'], 'add path serves the cache hit');

    // 'change' path must bypass the matching entry and re-read the real content.
    seed();
    const reanalyzed = await loadOrAnalyzeFile(proj, filePath, '.ts', { forceReanalyze: true });
    assert.ok(
      reanalyzed?.imports.includes('./real'),
      `expected fresh imports to include './real', got ${JSON.stringify(reanalyzed?.imports)}`,
    );
    assert.ok(
      !reanalyzed?.imports.includes('./stale'),
      'stale cached imports must not survive a change event',
    );
    // The re-analysis refreshes the cache entry for subsequent scans.
    assert.deepEqual(stale.get(filePath)?.imports, ['./real'], 'cache entry refreshed');
  });
});
