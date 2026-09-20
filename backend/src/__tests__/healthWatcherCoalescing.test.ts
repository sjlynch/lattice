import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirectoryRescanCoalescer } from '../health/watcher/setup.js';
import { CrossFileAnalyzer } from '../health/crossFileAnalyzer.js';
import type { ProjectWatcher } from '../health/watcher/types.js';
import type { HealthMetrics } from '../health/types.js';

// Two hot-path guards in the health watcher:
//   - a burst of directory add/remove events broadcasts ONE `rescan`
//     (a checkout creating forty directories used to push forty frames, each
//     of which made every client re-issue /api/scan);
//   - the present-file Set handed to the cross-file pass keeps its IDENTITY
//     across content-only passes, which is what the case-fold import index
//     (a WeakMap keyed by that Set) needs to hit instead of rebuilding.

test('directory rescan events within the window coalesce into one broadcast', async () => {
  const emitted: string[] = [];
  const proj = { root: 'C:\\p' } as unknown as ProjectWatcher;
  const rescan = createDirectoryRescanCoalescer(proj, (_p, dirPath) => emitted.push(dirPath), 20);
  for (let i = 0; i < 40; i++) rescan(`C:\\p\\dir${i}`);
  assert.deepEqual(emitted, []);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(emitted, ['C:\\p\\dir39'], 'one frame, carrying the last path');
  rescan('C:\\p\\later');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(emitted, ['C:\\p\\dir39', 'C:\\p\\later'], 'a later burst is its own frame');
});

function metrics(): HealthMetrics {
  return { loc: 1, score: 100, smells: [] } as unknown as HealthMetrics;
}

test('the present-file Set is reused across passes and rebuilt on membership change', () => {
  const m = new Map<string, HealthMetrics>([['C:\\p\\a.ts', metrics()], ['C:\\p\\b.ts', metrics()]]);
  const analyzer = new CrossFileAnalyzer({
    imports: new Map(),
    metrics: m,
    getAliases: () => [],
    broadcastUpdated: () => {},
    projectRoot: 'C:\\p',
    entryGlobs: [],
    packageRoots: new Set(),
  });
  const first = analyzer.presentFilesForPass();
  assert.equal(analyzer.presentFilesForPass(), first, 'a content-only pass reuses the Set');
  // Explicit invalidation (the add/remove handlers call this).
  m.set('C:\\p\\c.ts', metrics());
  analyzer.invalidateRoots();
  const second = analyzer.presentFilesForPass();
  assert.notEqual(second, first);
  assert.equal(second.size, 3);
  // Belt and braces: a membership change that skipped invalidateRoots is still
  // caught by the size check.
  m.delete('C:\\p\\a.ts');
  assert.equal(analyzer.presentFilesForPass().size, 2);
});
