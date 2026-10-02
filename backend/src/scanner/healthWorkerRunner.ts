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

import type { HealthMetrics } from '../health/index.js';
import {
  DEFAULT_ANALYSIS_STALL_MS,
  createStallTimer,
  spawnEvalWorker,
  terminateQuietly,
  type AnalysisWorkerHandle,
  type StallTimer,
} from '../health/analysisWorker.js';
import { WORKER_SRC } from './healthWorkerSource.js';

export type AnalysisJob = {
  // Position in the caller's file list, echoed back verbatim so results can be
  // applied in place regardless of ordering.
  index: number;
  filePath: string;
  ext: string;
  // Byte size from the scan's stat, when known. Lets readForAnalysis skip an
  // oversize file without reading it.
  size?: number;
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
// thread. `node:worker_threads`' Worker satisfies this. This runner needs
// nothing beyond the shared base type (`health/analysisWorker.ts`).
export type WorkerHandle = AnalysisWorkerHandle;

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

const DEFAULT_STALL_MS = DEFAULT_ANALYSIS_STALL_MS;
// Ceiling on respawns per run so a scan with many independently-hanging files
// can't loop forever; the leftover tail is handed back for in-thread fallback.
const MAX_RESPAWNS = 10;

function defaultCreateWorker(data: WorkerData): WorkerHandle {
  // spawnEvalWorker pins execArgv: [] (never inherit a TS loader). Not unref'd,
  // unlike the watcher's warm worker: a scan awaits this worker's results, and
  // it is terminated as soon as the run settles.
  return spawnEvalWorker(WORKER_SRC, data);
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

// One runHealthAnalysis call: owns the current worker, the slice it is
// processing, the stall watchdog and the respawn budget, and resolves the
// caller's promise exactly once via finish().
class HealthAnalysisRun {
  private settled = false;
  private worker: WorkerHandle | null = null;
  // Not unref'd on the scan path (the watcher's warm analyzer unrefs its own).
  private readonly stall: StallTimer;
  private cancelTimer: ReturnType<typeof setInterval> | null = null;
  private respawns = 0;

  // The slice of jobs the current worker is processing, and how many results
  // it has already returned. Results arrive in slice order, so slice[slicePos]
  // is always the job we're currently waiting for — i.e. the culprit on stall.
  private slice: AnalysisJob[] = [];
  private slicePos = 0;

  constructor(
    private readonly opts: RunHealthAnalysisOptions,
    private readonly stallMs: number,
    private readonly createWorker: WorkerFactory,
    private readonly urls: { analyzeUrl: string; readUrl: string },
    private readonly resolve: (result: RunHealthAnalysisResult) => void,
  ) {
    this.stall = createStallTimer(stallMs, () => this.onStall());
  }

  start(jobs: AnalysisJob[]): void {
    if (this.opts.isCancelled) {
      this.cancelTimer = setInterval(() => {
        if (this.opts.isCancelled?.()) this.finish(this.slice.slice(this.slicePos));
      }, 100);
    }
    this.spawn(jobs);
  }

  private killWorker(): void {
    if (this.worker) {
      terminateQuietly(this.worker);
      this.worker = null;
    }
  }

  private finish(unhandled: AnalysisJob[]): void {
    if (this.settled) return;
    this.settled = true;
    this.stall.clear();
    if (this.cancelTimer) {
      clearInterval(this.cancelTimer);
      this.cancelTimer = null;
    }
    this.killWorker();
    this.resolve({ unhandled });
  }

  private onMessage(msg: WorkerMessage): void {
    if (this.settled) return;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init-failed') {
      // Worker couldn't load the analysis modules — only happens on the first
      // spawn (before any results), so `slice` is the full job set. Hand all
      // back for in-thread fallback.
      if (process.env.LATTICE_HEALTH_DEBUG) {
        console.error('[health] analysis worker init failed:', msg.error);
      }
      this.finish(this.slice);
      return;
    }
    if (msg.type === 'ready') {
      this.stall.arm();
      return;
    }
    if (msg.type === 'done') {
      this.finish([]);
      return;
    }
    if (msg.type === 'result') {
      this.stall.arm();
      this.slicePos += 1;
      this.opts.onResult({
        index: msg.index,
        loc: msg.loc,
        analysis: msg.ok ? { metrics: msg.metrics as HealthMetrics, imports: msg.imports ?? [] } : null,
      });
    }
  }

  private onStall(): void {
    if (this.settled) return;
    const culprit = this.slice[this.slicePos];
    this.killWorker();
    console.warn(
      `[health] analysis worker exceeded ${this.stallMs}ms on ` +
        `${culprit ? culprit.filePath : '<unknown>'} — terminating and skipping ` +
        `that file (likely pathological input); the scan continues.`,
    );
    // The hung file is skipped (never retried — retrying would just hang again).
    if (culprit) this.opts.onResult({ index: culprit.index, loc: undefined, analysis: null });

    const rest = this.slice.slice(this.slicePos + 1);
    if (rest.length === 0) {
      this.finish([]);
      return;
    }
    this.respawns += 1;
    if (this.respawns > MAX_RESPAWNS) {
      console.warn(
        `[health] analysis worker respawn limit reached; ` +
          `handing ${rest.length} remaining file(s) to in-thread fallback.`,
      );
      this.finish(rest);
      return;
    }
    this.spawn(rest);
  }

  private onWorkerDeath(): void {
    if (this.settled) return;
    // Worker errored / exited before 'done'. Hand back everything it hadn't
    // yet returned so the caller finishes those in-thread. (The culprit of a
    // watchdog kill is already emitted + skipped in onStall before respawn, so
    // this path only sees genuinely-unprocessed jobs.)
    this.killWorker();
    this.finish(this.slice.slice(this.slicePos));
  }

  private spawn(sliceJobs: AnalysisJob[]): void {
    this.slice = sliceJobs;
    this.slicePos = 0;
    let w: WorkerHandle;
    try {
      w = this.createWorker({ analyzeUrl: this.urls.analyzeUrl, readUrl: this.urls.readUrl, jobs: sliceJobs });
    } catch (err) {
      if (process.env.LATTICE_HEALTH_DEBUG) {
        console.error('[health] analysis worker spawn failed:', err);
      }
      this.finish(sliceJobs);
      return;
    }
    this.worker = w;
    // Guard every listener so a terminated/stale worker's late events (a
    // respawned worker's predecessor still emits 'exit' after terminate())
    // can't corrupt the current slice bookkeeping.
    const guard =
      <A>(fn: (a: A) => void) =>
      (a: A): void => {
        if (this.settled || w !== this.worker) return;
        fn(a);
      };
    w.on('message', guard((m: WorkerMessage) => this.onMessage(m)));
    w.on('error', guard(() => this.onWorkerDeath()));
    w.on('exit', guard(() => this.onWorkerDeath()));
    this.stall.arm();
  }
}

export function runHealthAnalysis(
  jobs: AnalysisJob[],
  opts: RunHealthAnalysisOptions,
): Promise<RunHealthAnalysisResult> {
  if (jobs.length === 0) return Promise.resolve({ unhandled: [] });

  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const createWorker = opts.createWorker ?? defaultCreateWorker;
  const urls = opts.moduleUrls ?? defaultModuleUrls();

  return new Promise<RunHealthAnalysisResult>((resolve) => {
    new HealthAnalysisRun(opts, stallMs, createWorker, urls, resolve).start(jobs);
  });
}

