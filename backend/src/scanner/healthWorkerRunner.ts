// Isolate per-file health analysis in a WORKER THREAD so a single pathological
// file can't freeze the backend's main event loop.
//
// The universal smell regexes and the tree-sitter walk run synchronously and
// are CPU-bound; a catastrophic-backtracking regex (or any accidental infinite
// loop) on one file would otherwise pin the main thread and make the whole
// backend unresponsive — the symptom that motivated this module (frontend stuck
// on "scanning"). Running the analysis in a worker means such a hang can only
// block the WORKER's thread; the main thread keeps serving API/WS requests.
//
// Because a hung worker never returns a result on its own, we add a PER-FILE
// STALL WATCHDOG: the timer resets every time the worker reports a file, and
// only fires if a SINGLE file individually exceeds a very generous ceiling
// (DEFAULT_STALL_MS). So it cannot false-positive on a big-but-healthy scan
// (many fast files) — only on a file that genuinely hangs. On a trip we
// terminate the worker (safe: it only reads files and posts messages — no
// shared state, locks, or partial writes to corrupt), mark that one file
// unanalyzable, respawn, and continue. The scan completes; the bad file is a
// metrics-less graph node.
//
// Robustness contract: if the worker can't be used at all (e.g. running from
// `src` under tsx, where the compiled `analyze.js` sibling doesn't exist), the
// runner hands the affected jobs back as `unhandled` so the caller falls back
// to in-thread analysis — i.e. this can never be WORSE than the previous
// all-on-the-main-thread behaviour.

import { Worker } from 'node:worker_threads';
import type { HealthMetrics } from '../health/index.js';

export type AnalysisJob = {
  // Position in the caller's file list, echoed back verbatim so results can be
  // applied in place regardless of ordering.
  index: number;
  filePath: string;
  ext: string;
};

export type JobAnalysis = { metrics: HealthMetrics; imports: string[] };

export type AnalysisOutcome = {
  index: number;
  // Present when the worker managed to read the file (may be a minified/oversize
  // file that was counted but not analyzed).
  loc: number | undefined;
  // null = skipped/unanalyzable (minified, oversize, threw, or watchdog-killed).
  analysis: JobAnalysis | null;
};

// Minimal structural view of a worker so tests can inject a fake without a real
// thread. `node:worker_threads`' Worker satisfies this.
export type WorkerHandle = {
  on(event: 'message' | 'error' | 'exit', cb: (arg: any) => void): unknown;
  terminate(): unknown;
};

export type WorkerData = { analyzeUrl: string; readUrl: string; jobs: AnalysisJob[] };
export type WorkerFactory = (data: WorkerData) => WorkerHandle;

export type RunHealthAnalysisOptions = {
  onResult: (outcome: AnalysisOutcome) => void;
  isCancelled?: () => boolean;
  // Per-file stall ceiling. Generous by default — a healthy file (AST work is
  // capped at 1 MB, the regexes are linear) finishes in well under a second,
  // including first-file WASM init.
  stallMs?: number;
  // Test seams.
  createWorker?: WorkerFactory;
  moduleUrls?: { analyzeUrl: string; readUrl: string };
};

export type RunHealthAnalysisResult = {
  // Jobs the worker subsystem could not process (worker unavailable / died /
  // respawn limit hit). The caller should analyze these in-thread.
  unhandled: AnalysisJob[];
};

const DEFAULT_STALL_MS = 10_000;
// Ceiling on respawns per run so a scan with many independently-hanging files
// can't loop forever; the leftover tail is handed back for in-thread fallback.
const MAX_RESPAWNS = 10;

// Inline worker source (CJS `require` + dynamic `import()` of the ESM analysis
// modules by URL). Mirrors search.ts's proven eval-worker pattern. Kept as a
// string so there's no separate file to compile/ship; the compiled analysis
// modules are located by URLs the parent passes in workerData.
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
// Keep-alive: hold the worker's event loop open after the job loop finishes so
// it only exits on the parent's explicit terminate(). This makes 'exit' an
// unambiguous "we killed it / it crashed" signal and guarantees all posted
// messages (results + 'done') drain to the parent before any exit.
parentPort.on('message', () => {});
(async () => {
  let analyzeFile, readForAnalysis;
  try {
    const [analyzeMod, readMod] = await Promise.all([
      import(workerData.analyzeUrl),
      import(workerData.readUrl),
    ]);
    analyzeFile = analyzeMod.analyzeFile;
    readForAnalysis = readMod.readForAnalysis;
  } catch (err) {
    // e.g. running from src under tsx: the compiled .js siblings don't exist.
    parentPort.postMessage({ type: 'init-failed', error: String((err && err.message) || err) });
    return;
  }
  parentPort.postMessage({ type: 'ready' });
  for (const job of workerData.jobs) {
    let loc;
    try {
      const read = await readForAnalysis(job.filePath);
      loc = read.loc;
      if (read.content === undefined) {
        parentPort.postMessage({ type: 'result', index: job.index, loc: loc, ok: false });
        continue;
      }
      const res = await analyzeFile(read.content, job.ext, loc || 0);
      parentPort.postMessage({
        type: 'result', index: job.index, loc: loc, ok: true,
        metrics: res.metrics, imports: res.imports,
      });
    } catch (err) {
      parentPort.postMessage({ type: 'result', index: job.index, loc: loc, ok: false });
    }
  }
  parentPort.postMessage({ type: 'done' });
})();
`;

function defaultCreateWorker(data: WorkerData): WorkerHandle {
  // execArgv: [] so the worker never inherits a TS-loader (`--import tsx`, …)
  // from the parent's exec args. The repo has repeatedly been bitten by loader
  // injection propagating into child processes (see backend/scripts/dev.mjs).
  return new Worker(WORKER_SRC, { eval: true, workerData: data, execArgv: [] });
}

function defaultModuleUrls(): { analyzeUrl: string; readUrl: string } {
  return {
    analyzeUrl: new URL('../health/analyze.js', import.meta.url).href,
    readUrl: new URL('./readForAnalysis.js', import.meta.url).href,
  };
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'init-failed'; error?: string }
  | { type: 'done' }
  | { type: 'result'; index: number; loc?: number; ok: boolean; metrics?: HealthMetrics; imports?: string[] };

export function runHealthAnalysis(
  jobs: AnalysisJob[],
  opts: RunHealthAnalysisOptions,
): Promise<RunHealthAnalysisResult> {
  if (jobs.length === 0) return Promise.resolve({ unhandled: [] });

  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const createWorker = opts.createWorker ?? defaultCreateWorker;
  const urls = opts.moduleUrls ?? defaultModuleUrls();

  return new Promise<RunHealthAnalysisResult>((resolve) => {
    let settled = false;
    let worker: WorkerHandle | null = null;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelTimer: ReturnType<typeof setInterval> | null = null;
    let respawns = 0;

    // The slice of jobs the current worker is processing, and how many results
    // it has already returned. Results arrive in slice order, so slice[slicePos]
    // is always the job we're currently waiting for — i.e. the culprit on stall.
    let slice: AnalysisJob[] = [];
    let slicePos = 0;

    const clearStall = (): void => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    const armStall = (): void => {
      clearStall();
      stallTimer = setTimeout(onStall, stallMs);
    };
    const killWorker = (): void => {
      if (worker) {
        try {
          worker.terminate();
        } catch {
          /* ignore */
        }
        worker = null;
      }
    };
    const finish = (unhandled: AnalysisJob[]): void => {
      if (settled) return;
      settled = true;
      clearStall();
      if (cancelTimer) {
        clearInterval(cancelTimer);
        cancelTimer = null;
      }
      killWorker();
      resolve({ unhandled });
    };

    const onMessage = (msg: WorkerMessage): void => {
      if (settled) return;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'init-failed') {
        // Worker couldn't load the analysis modules — only happens on the first
        // spawn (before any results), so `slice` is the full job set. Hand all
        // back for in-thread fallback.
        if (process.env.LATTICE_HEALTH_DEBUG) {
          console.error('[health] analysis worker init failed:', msg.error);
        }
        finish(slice);
        return;
      }
      if (msg.type === 'ready') {
        armStall();
        return;
      }
      if (msg.type === 'done') {
        finish([]);
        return;
      }
      if (msg.type === 'result') {
        armStall();
        slicePos += 1;
        opts.onResult({
          index: msg.index,
          loc: msg.loc,
          analysis: msg.ok ? { metrics: msg.metrics as HealthMetrics, imports: msg.imports ?? [] } : null,
        });
      }
    };

    const onStall = (): void => {
      if (settled) return;
      const culprit = slice[slicePos];
      killWorker();
      console.warn(
        `[health] analysis worker exceeded ${stallMs}ms on ` +
          `${culprit ? culprit.filePath : '<unknown>'} — terminating and skipping ` +
          `that file (likely pathological input); the scan continues.`,
      );
      // The hung file is skipped (never retried — retrying would just hang again).
      if (culprit) opts.onResult({ index: culprit.index, loc: undefined, analysis: null });

      const rest = slice.slice(slicePos + 1);
      if (rest.length === 0) {
        finish([]);
        return;
      }
      respawns += 1;
      if (respawns > MAX_RESPAWNS) {
        console.warn(
          `[health] analysis worker respawn limit reached; ` +
            `handing ${rest.length} remaining file(s) to in-thread fallback.`,
        );
        finish(rest);
        return;
      }
      spawn(rest);
    };

    const onWorkerDeath = (): void => {
      if (settled) return;
      // Worker errored / exited before 'done'. Hand back everything it hadn't
      // yet returned so the caller finishes those in-thread. (The culprit of a
      // watchdog kill is already emitted + skipped in onStall before respawn, so
      // this path only sees genuinely-unprocessed jobs.)
      killWorker();
      finish(slice.slice(slicePos));
    };

    const spawn = (sliceJobs: AnalysisJob[]): void => {
      slice = sliceJobs;
      slicePos = 0;
      let w: WorkerHandle;
      try {
        w = createWorker({ analyzeUrl: urls.analyzeUrl, readUrl: urls.readUrl, jobs: sliceJobs });
      } catch (err) {
        if (process.env.LATTICE_HEALTH_DEBUG) {
          console.error('[health] analysis worker spawn failed:', err);
        }
        finish(sliceJobs);
        return;
      }
      worker = w;
      // Guard every listener so a terminated/stale worker's late events (a
      // respawned worker's predecessor still emits 'exit' after terminate())
      // can't corrupt the current slice bookkeeping.
      const guard =
        <A>(fn: (a: A) => void) =>
        (a: A): void => {
          if (settled || w !== worker) return;
          fn(a);
        };
      w.on('message', guard(onMessage));
      w.on('error', guard(onWorkerDeath));
      w.on('exit', guard(onWorkerDeath));
      armStall();
    };

    if (opts.isCancelled) {
      cancelTimer = setInterval(() => {
        if (opts.isCancelled?.()) finish(slice.slice(slicePos));
      }, 100);
    }

    spawn(jobs);
  });
}
