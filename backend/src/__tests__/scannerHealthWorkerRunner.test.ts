import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runHealthAnalysis } from '../scanner/healthWorkerRunner.js';
import type {
  AnalysisJob,
  AnalysisOutcome,
  WorkerData,
  WorkerHandle,
} from '../scanner/healthWorkerRunner.js';
import { withTempDir } from './helpers/tempDir.js';

// A controllable fake worker so the coordinator's watchdog / respawn / fallback
// logic can be driven deterministically without a real thread. Mirrors the
// node:worker_threads Worker surface the runner uses (on/terminate + emitted
// 'message'/'error'/'exit' events).
class FakeWorker implements WorkerHandle {
  handlers: Record<'message' | 'error' | 'exit', ((a: unknown) => void)[]> = {
    message: [],
    error: [],
    exit: [],
  };
  terminated = false;
  constructor(readonly data: WorkerData) {}
  on(event: 'message' | 'error' | 'exit', cb: (a: unknown) => void): this {
    this.handlers[event].push(cb);
    return this;
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  emit(event: 'message' | 'error' | 'exit', arg?: unknown): void {
    for (const cb of [...this.handlers[event]]) cb(arg);
  }
}

function capturingFactory() {
  const created: FakeWorker[] = [];
  const createWorker = (data: WorkerData): WorkerHandle => {
    const w = new FakeWorker(data);
    created.push(w);
    return w;
  };
  return { created, createWorker };
}

const metrics = (score: number) => ({ score }) as never; // sentinel HealthMetrics
const URLS = { analyzeUrl: 'test://analyze', readUrl: 'test://read' };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const job = (index: number, name = `f${index}.ts`): AnalysisJob => ({
  index,
  filePath: name,
  ext: '.ts',
});

test('runHealthAnalysis: happy path delivers every result in order and terminates', async () => {
  const { created, createWorker } = capturingFactory();
  const outcomes: AnalysisOutcome[] = [];
  const p = runHealthAnalysis([job(0), job(1)], {
    onResult: (o) => outcomes.push(o),
    createWorker,
    moduleUrls: URLS,
    stallMs: 10_000,
  });
  const w = created[0];
  assert.equal(w.data.jobs.length, 2);
  w.emit('message', { type: 'ready' });
  w.emit('message', { type: 'result', index: 0, loc: 3, ok: true, metrics: metrics(90), imports: ['x'] });
  w.emit('message', { type: 'result', index: 1, loc: 5, ok: false });
  w.emit('message', { type: 'done' });

  const res = await p;
  assert.deepEqual(res.unhandled, []);
  assert.deepEqual(outcomes, [
    { index: 0, loc: 3, analysis: { metrics: metrics(90), imports: ['x'] } },
    { index: 1, loc: 5, analysis: null },
  ]);
  assert.equal(w.terminated, true);
});

test('runHealthAnalysis: a stalled file is skipped and the rest continue on a fresh worker', async () => {
  const { created, createWorker } = capturingFactory();
  const outcomes: AnalysisOutcome[] = [];
  const p = runHealthAnalysis([job(0), job(1, 'HANG.ts'), job(2)], {
    onResult: (o) => outcomes.push(o),
    createWorker,
    moduleUrls: URLS,
    stallMs: 30,
  });
  const w1 = created[0];
  w1.emit('message', { type: 'ready' });
  w1.emit('message', { type: 'result', index: 0, loc: 3, ok: true, metrics: metrics(80), imports: [] });
  // w1 now "hangs" on job 1 — emit nothing and let the per-file watchdog fire.
  await sleep(150);

  assert.equal(w1.terminated, true, 'the hung worker is terminated');
  assert.equal(created.length, 2, 'a fresh worker is respawned for the remainder');
  const w2 = created[1];
  assert.deepEqual(
    w2.data.jobs.map((j) => j.index),
    [2],
    'respawn only carries the jobs after the culprit',
  );
  w2.emit('message', { type: 'ready' });
  w2.emit('message', { type: 'result', index: 2, loc: 7, ok: true, metrics: metrics(70), imports: [] });
  w2.emit('message', { type: 'done' });

  const res = await p;
  assert.deepEqual(res.unhandled, []);
  assert.deepEqual(
    outcomes.map((o) => o.index),
    [0, 1, 2],
  );
  assert.deepEqual(outcomes[1], { index: 1, loc: undefined, analysis: null }, 'the culprit is skipped');
});

test('runHealthAnalysis: worker init failure hands all jobs back for in-thread fallback', async () => {
  const { created, createWorker } = capturingFactory();
  const outcomes: AnalysisOutcome[] = [];
  const p = runHealthAnalysis([job(0), job(1)], {
    onResult: (o) => outcomes.push(o),
    createWorker,
    moduleUrls: URLS,
  });
  created[0].emit('message', { type: 'init-failed', error: 'no compiled analyze.js (src under tsx)' });

  const res = await p;
  assert.deepEqual(
    res.unhandled.map((j) => j.index),
    [0, 1],
  );
  assert.equal(outcomes.length, 0);
  assert.equal(created[0].terminated, true);
});

test('runHealthAnalysis: an unexpected worker exit hands back the unprocessed tail', async () => {
  const { created, createWorker } = capturingFactory();
  const outcomes: AnalysisOutcome[] = [];
  const p = runHealthAnalysis([job(0), job(1), job(2)], {
    onResult: (o) => outcomes.push(o),
    createWorker,
    moduleUrls: URLS,
    stallMs: 10_000,
  });
  const w = created[0];
  w.emit('message', { type: 'ready' });
  w.emit('message', { type: 'result', index: 0, loc: 1, ok: true, metrics: metrics(50), imports: [] });
  w.emit('exit', 1); // crashed after one result

  const res = await p;
  assert.deepEqual(
    res.unhandled.map((j) => j.index),
    [1, 2],
  );
  assert.equal(outcomes.length, 1);
});

test('runHealthAnalysis: cancellation stops promptly and returns the unprocessed tail', async () => {
  const { created, createWorker } = capturingFactory();
  const outcomes: AnalysisOutcome[] = [];
  let cancelled = false;
  const p = runHealthAnalysis([job(0), job(1)], {
    onResult: (o) => outcomes.push(o),
    createWorker,
    moduleUrls: URLS,
    stallMs: 10_000,
    isCancelled: () => cancelled,
  });
  const w = created[0];
  w.emit('message', { type: 'ready' });
  w.emit('message', { type: 'result', index: 0, loc: 1, ok: true, metrics: metrics(50), imports: [] });
  cancelled = true; // the cancel poll runs every 100ms

  const res = await p;
  assert.deepEqual(
    res.unhandled.map((j) => j.index),
    [1],
  );
  assert.equal(w.terminated, true);
});

test('runHealthAnalysis: no jobs resolves immediately without spawning a worker', async () => {
  const res = await runHealthAnalysis([], {
    onResult: () => assert.fail('no results expected'),
    createWorker: () => assert.fail('should not spawn a worker'),
  });
  assert.deepEqual(res.unhandled, []);
});

test('runHealthAnalysis: a spawn error falls back to in-thread for all jobs', async () => {
  const res = await runHealthAnalysis([job(0)], {
    onResult: () => assert.fail('no results expected'),
    createWorker: () => {
      throw new Error('spawn boom');
    },
    moduleUrls: URLS,
  });
  assert.deepEqual(
    res.unhandled.map((j) => j.index),
    [0],
  );
});

// End-to-end with the REAL worker thread (tree-sitter WASM + the compiled
// analysis pipeline). Only runnable once dist/ is built — under plain `npm test`
// (tsx over src) the compiled .js siblings don't exist, so we point moduleUrls
// at dist/ and skip when it's absent. This is the automated proof that the
// worker actually analyzes files (the coordinator logic itself is covered above
// with the fake worker).
const distDir = path.resolve(fileURLToPath(new URL('../../dist', import.meta.url)));
const distReady =
  fsSync.existsSync(path.join(distDir, 'health', 'analyze.js')) &&
  fsSync.existsSync(path.join(distDir, 'scanner', 'readForAnalysis.js'));

test(
  'runHealthAnalysis (real worker): analyzes a file and skips an unreadable one',
  { skip: distReady ? false : 'dist not built' },
  async () => {
    await withTempDir('lattice-health-worker-', async (dir) => {
      const good = path.join(dir, 'good.ts');
      await fs.writeFile(
        good,
        'export function add(a: number, b: number) {\n  if (a > 0) return a + b;\n  return b;\n}\n',
      );
      const missing = path.join(dir, 'missing.ts'); // never created

      const outcomes: AnalysisOutcome[] = [];
      const res = await runHealthAnalysis(
        [
          { index: 0, filePath: good, ext: '.ts' },
          { index: 1, filePath: missing, ext: '.ts' },
        ],
        {
          onResult: (o) => outcomes.push(o),
          moduleUrls: {
            analyzeUrl: pathToFileURL(path.join(distDir, 'health', 'analyze.js')).href,
            readUrl: pathToFileURL(path.join(distDir, 'scanner', 'readForAnalysis.js')).href,
          },
        },
      );

      assert.deepEqual(res.unhandled, [], 'real worker handled both jobs');
      const byIndex = new Map(outcomes.map((o) => [o.index, o]));
      const goodOutcome = byIndex.get(0);
      assert.ok(goodOutcome?.analysis, 'the real file produced metrics');
      assert.equal(typeof goodOutcome!.analysis!.metrics.score, 'number');
      assert.equal(byIndex.get(1)?.analysis, null, 'the missing file is skipped, not fatal');
    });
  },
);

// The core guarantee, proven end-to-end: a genuinely-hung file (a REAL infinite
// loop on a REAL worker thread) is killed by the watchdog, the scan still
// completes, and — critically — the main event loop keeps running the whole
// time. If analysis ran on the main thread (the old behaviour), the infinite
// loop would block this test's ticker AND the test itself would hang forever;
// its completion is the proof of isolation. Uses a plain-JS fixture (no dist
// dependency), so it runs under plain `npm test`.
test('runHealthAnalysis (real worker): a hung file is killed by the watchdog while the main thread stays alive', async () => {
  const fixtureUrl = new URL('./helpers/hangAnalyzeFixture.mjs', import.meta.url).href;
  const outcomes: AnalysisOutcome[] = [];
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 10);
  try {
    const res = await runHealthAnalysis(
      [job(0, 'a.ts'), job(1, 'HANG.ts'), job(2, 'c.ts')],
      {
        onResult: (o) => outcomes.push(o),
        moduleUrls: { analyzeUrl: fixtureUrl, readUrl: fixtureUrl },
        stallMs: 150,
      },
    );
    assert.deepEqual(res.unhandled, [], 'the scan completed despite the hang');
    const byIndex = new Map(outcomes.map((o) => [o.index, o]));
    assert.ok(byIndex.get(0)?.analysis, 'file before the hang was analyzed');
    assert.equal(byIndex.get(1)?.analysis, null, 'the hung file was skipped');
    assert.ok(byIndex.get(2)?.analysis, 'file after the hang analyzed on the respawned worker');
    assert.ok(ticks > 0, 'the main event loop kept ticking while the worker was hung');
  } finally {
    clearInterval(ticker);
  }
});
