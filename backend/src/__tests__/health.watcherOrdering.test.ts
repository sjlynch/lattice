import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { HealthCache } from '../health/cache.js';
import { ConfigReloader } from '../health/configReloader.js';
import { createWatcherHandlers } from '../health/watcher/handlers.js';
import { loadOrAnalyzeFile, type AnalyzedFile } from '../health/watcher/fileAnalysis.js';
import { WatcherRevision } from '../health/watcher/revision.js';
import type { HealthUpdate, ProjectWatcher } from '../health/watcher/types.js';
import { minimalMetrics } from './helpers/health.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function project(root: string) {
  const updates: HealthUpdate[] = [];
  const scheduled: Array<string | null> = [];
  const proj = {
    root,
    cache: new HealthCache(root),
    imports: new Map(),
    metrics: new Map(),
    revision: new WatcherRevision(),
    config: { reloadForPath: async () => false, reloadAliasesForNestedTsconfig: async () => false },
    watcher: { add() {} },
    crossFile: { invalidateRoots() {}, scheduleRecompute(p: string | null) { scheduled.push(p); } },
    subscribers: new Set([(update: HealthUpdate) => updates.push(update)]),
  } as unknown as ProjectWatcher;
  return { proj, updates, scheduled };
}

test('unlink fences an already-running analysis before maps or cache can resurrect a file', async () => {
  await withTempDir('lattice-watch-delete-order-', async (root) => {
    await writeLayout(root, { 'a.ts': 'export const a = 1;' });
    const file = path.join(root, 'a.ts');
    const { proj, updates } = project(root);
    const started = deferred<void>();
    const result = deferred<AnalyzedFile>();
    const handlers = createWatcherHandlers(proj, (p, f, ext, opts) =>
      loadOrAnalyzeFile(p, f, ext, opts, async () => {
        started.resolve();
        return result.promise;
      }));
    const changing = handlers.onAddOrChange(file, 'change');
    await started.promise;
    await handlers.onRemove(file);
    result.resolve({ metrics: minimalMetrics({ loc: 99 }), imports: ['./old'] });
    await changing;
    assert.equal(proj.metrics.has(file), false);
    assert.equal(proj.imports.has(file), false);
    assert.deepEqual([...proj.cache.entries()], []);
    assert.deepEqual(updates, [{ type: 'removed', filePath: file }]);
    await proj.cache.flush();
  });
});

test('newer edit wins when the previous file analysis resolves last', async () => {
  await withTempDir('lattice-watch-edit-order-', async (root) => {
    await writeLayout(root, { 'a.ts': 'export const a = 1;' });
    const file = path.join(root, 'a.ts');
    const { proj, scheduled } = project(root);
    const started = deferred<void>();
    const old = deferred<AnalyzedFile>();
    let calls = 0;
    const fresh = { metrics: minimalMetrics({ loc: 2 }), imports: ['./new'] };
    const handlers = createWatcherHandlers(proj, (p, f, ext, opts) =>
      loadOrAnalyzeFile(p, f, ext, opts, async () => {
        if (++calls === 1) { started.resolve(); return old.promise; }
        return fresh;
      }));
    const first = handlers.onAddOrChange(file, 'change');
    await started.promise;
    await handlers.onAddOrChange(file, 'change');
    old.resolve({ metrics: minimalMetrics({ loc: 99 }), imports: ['./old'] });
    await first;
    assert.deepEqual(proj.metrics.get(file), fresh.metrics);
    assert.deepEqual(proj.imports.get(file), fresh.imports);
    assert.deepEqual([...proj.cache.entries()][0]?.[1].imports, fresh.imports);
    assert.deepEqual(scheduled, [file]);
    await proj.cache.flush();
  });
});

test('event ownership is stamped before waiting for config', async () => {
  const { proj } = project(path.resolve('watch-config-order'));
  const config = deferred<boolean>();
  let calls = 0;
  proj.config.reloadForPath = () => ++calls === 1 ? config.promise : Promise.resolve(false);
  let analyses = 0;
  const handlers = createWatcherHandlers(proj, async () => { analyses++; return null; });
  const file = path.join(proj.root, 'a.ts');
  const first = handlers.onAddOrChange(file, 'change');
  await handlers.onRemove(file);
  config.resolve(false);
  await first;
  assert.equal(analyses, 0);
  await proj.cache.flush();
});

test('a nested tsconfig edit re-runs cross-file without a rescan broadcast or analysis', async () => {
  const { proj, updates, scheduled } = project(path.resolve('watch-nested-tsconfig'));
  const nested = path.join(proj.root, 'frontend', 'tsconfig.app.json');
  let reloaded = 0;
  proj.config.reloadAliasesForNestedTsconfig = async (p: string) => {
    if (p !== nested) return false;
    reloaded++;
    return true;
  };
  let analyses = 0;
  const handlers = createWatcherHandlers(proj, async () => { analyses++; return null; });
  await handlers.onAddOrChange(nested, 'change');
  await handlers.onRemove(nested);
  assert.equal(reloaded, 2);
  assert.equal(analyses, 0);
  assert.deepEqual(scheduled, [null, null]);
  assert.deepEqual(updates, []);
});

test('overlapping config reloads retain the most recent ignore contents', async (t) => {
  const root = path.resolve('watch-ignore-order');
  const config = new ConfigReloader(root);
  const first = deferred<Ignore>();
  let calls = 0;
  // Hold the I/O boundary; the configuration's public reload path still owns
  // its revision and final assignment.
  t.mock.method(config as unknown as { loadGitignore: () => unknown }, 'loadGitignore', () =>
    ++calls === 1 ? first.promise : Promise.resolve(ignore().add('new.ts')));
  const oldReload = config.reloadForPath(path.join(root, '.gitignore'));
  await config.reloadForPath(path.join(root, '.gitignore'));
  first.resolve(ignore().add('old.ts'));
  await oldReload;
  assert.equal(config.isIgnored(path.join(root, 'new.ts')), true);
  assert.equal(config.isIgnored(path.join(root, 'old.ts')), false);
});
