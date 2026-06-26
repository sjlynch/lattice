// Concurrency/robustness regressions for the health subsystem:
//   1. ensureWatcher must de-dup in-flight builds so two concurrent
//      first-subscriptions for one root share ONE watcher (no orphaned,
//      still-running duplicate chokidar watcher + second cache writer).
//   2. HealthCache._doSave must write atomically (temp→rename) so two
//      independent instances (the scanner's + the watcher's) writing the same
//      <root>/.lattice/health-cache.json can never interleave into truncated
//      JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HealthCache } from '../health/cache.js';
import {
  subscribeHealth,
  _watcherCountForTest,
  _resetWatchersForTest,
} from '../health/watcher.js';
import { minimalMetrics } from './helpers/health.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

// BUG 1. Before the fix ensureWatcher was a check-then-act with a wide await
// window: `watchers.get()` → several awaits (cache.load / ConfigReloader.create
// / getUserSettings / readPackageJsonRoots) → `watchers.set()`. Two subscribes
// landing before the first resolved both saw no watcher and each built a full
// ProjectWatcher; the second set() overwrote (orphaned, never .close()d) the
// first. Now the creation PROMISE is memoized synchronously, so both share it.
test('concurrent first-subscriptions build exactly one watcher', async () => {
  await withTempDir('lattice-health-watcher-dedup-', async (dir) => {
    await writeLayout(dir, { 'a.ts': 'export const a = 1;\n' });
    await _resetWatchersForTest();
    try {
      // Fire both WITHOUT awaiting the first — the exact race (two /ws/health
      // connects at boot, a reconnect storm, HMR) the bug needed.
      const [un1, un2] = await Promise.all([
        subscribeHealth(dir, () => {}),
        subscribeHealth(dir, () => {}),
      ]);
      assert.equal(
        _watcherCountForTest(),
        1,
        'two concurrent first-subscriptions must not leak a duplicate watcher',
      );
      un1();
      un2();
    } finally {
      await _resetWatchersForTest();
    }
  });
});

// BUG 2. Two independent HealthCache instances target one health-cache.json
// (per-request scanner + long-lived watcher). The old `fs.writeFile` opened the
// file truncating; two concurrent writes could interleave into invalid JSON,
// which load() then rejects, wasting a full re-analysis. Atomic temp→rename
// makes every observed file a complete snapshot. Big, different-length payloads
// make a non-atomic interleave reliably corrupt the file.
test('concurrent flush() from multiple HealthCache instances never corrupts the file', async () => {
  await withTempDir('lattice-health-cache-atomic-', async (dir) => {
    const cacheFile = path.join(dir, '.lattice', 'health-cache.json');
    const bigImports = (n: number) =>
      Array.from({ length: n }, (_, i) => `./module-with-a-longish-name-${i}`);

    for (let round = 0; round < 30; round++) {
      // Four instances, deliberately different snapshot sizes so a torn write
      // (longer over shorter, or a truncated tail) yields unparseable JSON.
      const instances = [400, 120, 250, 60].map((count, idx) => {
        const c = new HealthCache(dir);
        for (let f = 0; f < count; f++) {
          c.set(
            `inst${idx}/file-${f}.ts`,
            round * 1000 + f,
            f,
            minimalMetrics({ loc: f }),
            bigImports(8),
          );
        }
        return c;
      });

      await Promise.all(instances.map((c) => c.flush()));

      const raw = await fs.readFile(cacheFile, 'utf8');
      // The whole point: whatever writer won the race, the file parses.
      const parsed = JSON.parse(raw) as { version: number; files: unknown };
      assert.ok(parsed.files, 'parsed cache must have a files map');
    }

    // No orphaned temp files left behind by the atomic writer.
    const leftover = (await fs.readdir(path.join(dir, '.lattice'))).filter((f) =>
      f.endsWith('.tmp'),
    );
    assert.deepEqual(leftover, [], `atomic writer leaked temp files: ${leftover}`);
  });
});
