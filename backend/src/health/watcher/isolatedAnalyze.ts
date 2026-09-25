// Persistent, warm worker for the file WATCHER's single-file analysis.
//
// The watcher analyzes one file per debounced add/change event. Routing that
// through the scan's per-batch worker would spawn (and WASM-init) a fresh worker
// per changed file — a spawn storm on a checkout / format-all. Instead this
// keeps ONE warm worker alive and feeds it jobs through a SERIAL queue (a single
// job in flight at a time), so the tree-sitter runtime is initialized once and
// reused, and the per-file stall watchdog has an unambiguous culprit (the single
// in-flight job).
//
// Same guarantees as the scan path (healthWorkerRunner.ts): a genuinely-hung
// file can only pin the WORKER thread; the watchdog terminates it and the queue
// continues on a fresh worker. If the worker subsystem is unusable (e.g. running
// from `src` under tsx, where the compiled analyze.js sibling doesn't exist),
// `analyze()` rejects with WorkerUnavailableError so the caller falls back to
// in-thread analysis.
//
// That fallback is the one path where this module's protection is off: it runs
// the same tree-sitter WASM analyzer on the backend's MAIN thread, where a hang
// freezes the event loop and a fault in the WASM runtime takes the process down
// with no chance to log it. So falling back is deliberately temporary — see
// UNAVAILABLE_COOLDOWN_MS.

import type { HealthMetrics } from '../types.js';
import {
  DEFAULT_ANALYSIS_STALL_MS,
  createStallTimer,
  spawnEvalWorker,
  terminateQuietly,
  type AnalysisWorkerHandle,
  type StallTimer,
} from '../analysisWorker.js';

export type IsolatedAnalysis = { metrics: HealthMetrics; imports: string[] };

// Thrown when the worker cannot be used at all (init/spawn failure or the
// respawn ceiling was hit). The caller should analyze this file in-thread. A
// null resolution is DIFFERENT: it means the worker ran the file and it was
// unanalyzable (threw or was watchdog-killed) — that file must be skipped, never
// retried in-thread (retrying a hang would re-hang the main thread).
export class WorkerUnavailableError extends Error {
  constructor() {
    super('isolated analyzer worker unavailable');
    this.name = 'WorkerUnavailableError';
  }
}

// Minimal structural worker view so tests can inject a fake without a real thread.
// The shared base (`on` / `terminate`, ../analysisWorker.ts) plus the job channel.
export type WorkerHandle = AnalysisWorkerHandle & {
  postMessage(value: unknown): void;
  unref?(): unknown;
};
export type WorkerData = { analyzeUrl: string };
export type WorkerFactory = (data: WorkerData) => WorkerHandle;

const DEFAULT_STALL_MS = DEFAULT_ANALYSIS_STALL_MS;
const MAX_SPAWN_FAILURES = 3;
// How long the worker stays written off after the failure ceiling is hit.
//
// This used to be forever. That mattered more than it looks: the in-thread
// fallback runs the SAME tree-sitter WASM analyzer on the backend's main
// thread, which is the exact arrangement this module exists to escape — so
// three transient worker deaths (a spawn losing a race during a "Run All", a
// worker killed while the machine was thrashing) permanently moved every
// subsequent file's WASM parse onto the event loop, for the life of the
// process, with no way back short of a restart. On the main thread a hang
// freezes the backend and a fault in the WASM runtime takes it down outright.
// A cooldown keeps the give-up (which is still the right immediate move) from
// being irreversible. Init failure is separate and stays permanent — see
// `permanentlyUnavailable`.
const UNAVAILABLE_COOLDOWN_MS = 60_000;

// Content-based worker: the parent sends {content, ext, loc}; the worker runs
// analyzeFile and posts one result. Serial (one job in flight), so no job id is
// needed. The message listener keeps the worker alive between jobs.
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const analyzeReady = import(workerData.analyzeUrl).then(
  (m) => m.analyzeFile,
  (err) => { parentPort.postMessage({ type: 'init-failed', error: String((err && err.message) || err) }); return null; }
);
parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'job') return;
  const analyzeFile = await analyzeReady;
  if (!analyzeFile) return; // init already reported failed
  try {
    const res = await analyzeFile(msg.content, msg.ext, msg.loc);
    parentPort.postMessage({ type: 'result', ok: true, metrics: res.metrics, imports: res.imports });
  } catch (err) {
    parentPort.postMessage({ type: 'result', ok: false });
  }
});
`;

function defaultCreateWorker(data: WorkerData): WorkerHandle {
  // spawnEvalWorker pins execArgv: [] so the worker never inherits a TS loader
  // (see dev.mjs). unref() so a warm idle worker never keeps the process from
  // exiting.
  return spawnEvalWorker(WORKER_SRC, data, { unref: true });
}

function defaultAnalyzeUrl(): string {
  return new URL('../analyze.js', import.meta.url).href;
}

type Pending = {
  content: string;
  ext: string;
  loc: number;
  resolve: (a: IsolatedAnalysis | null) => void;
  reject: (err: unknown) => void;
};

type WorkerMessage =
  | { type: 'init-failed'; error?: string }
  | { type: 'result'; ok: boolean; metrics?: HealthMetrics; imports?: string[] };

export type IsolatedAnalyzerOptions = {
  stallMs?: number;
  createWorker?: WorkerFactory;
  analyzeUrl?: string;
  // Test seam: how long the worker stays written off after the failure ceiling.
  cooldownMs?: number;
};

export class IsolatedAnalyzer {
  private readonly stallMs: number;
  private readonly createWorker: WorkerFactory;
  private readonly analyzeUrl: string;
  private readonly cooldownMs: number;

  private worker: WorkerHandle | null = null;
  private inFlight: Pending | null = null;
  private readonly queue: Pending[] = [];
  private readonly stall: StallTimer;
  private spawnFailures = 0;
  // Init failure means the compiled analyze.js isn't loadable at all (src under
  // tsx, a broken build) — retrying can never help, so this one is for good.
  private permanentlyUnavailable = false;
  // Spawn failures / unexpected deaths are transient by nature, so they only
  // write the worker off until this timestamp.
  private unavailableUntil = 0;

  constructor(opts: IsolatedAnalyzerOptions = {}) {
    this.stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    this.createWorker = opts.createWorker ?? defaultCreateWorker;
    this.analyzeUrl = opts.analyzeUrl ?? defaultAnalyzeUrl();
    this.cooldownMs = opts.cooldownMs ?? UNAVAILABLE_COOLDOWN_MS;
    // unref: a pending watchdog must not hold the event loop open at shutdown
    // (every other timer in the codebase is unref'd; this one kept the process
    // alive for up to stallMs after the last handle closed).
    this.stall = createStallTimer(this.stallMs, () => this.onStall(), { unref: true });
  }

  // True while the worker is written off: permanently after an init failure,
  // or until the cooldown expires after the spawn/death ceiling.
  private isUnavailable(): boolean {
    return this.permanentlyUnavailable || Date.now() < this.unavailableUntil;
  }

  // Hit the failure ceiling: stop trying for a while, and reset the counter so
  // the next window gets its own full budget rather than failing on contact.
  private giveUpForNow(): void {
    this.unavailableUntil = Date.now() + this.cooldownMs;
    this.spawnFailures = 0;
  }

  // Resolves to the analysis, or null if the worker ran the file and it was
  // unanalyzable (threw / watchdog-killed → skip, do NOT retry in-thread).
  // Rejects with WorkerUnavailableError if the worker can't be used at all
  // (caller should fall back to in-thread analysis).
  analyze(content: string, ext: string, loc: number): Promise<IsolatedAnalysis | null> {
    if (this.isUnavailable()) return Promise.reject(new WorkerUnavailableError());
    return new Promise<IsolatedAnalysis | null>((resolve, reject) => {
      this.queue.push({ content, ext, loc, resolve, reject });
      this.pump();
    });
  }

  dispose(): void {
    this.stall.clear();
    this.killWorker();
    const err = new WorkerUnavailableError();
    if (this.inFlight) {
      this.inFlight.reject(err);
      this.inFlight = null;
    }
    for (const item of this.queue.splice(0)) item.reject(err);
  }

  private pump(): void {
    if (this.inFlight) return;
    if (this.queue.length === 0) return;
    if (this.isUnavailable()) {
      for (const item of this.queue.splice(0)) item.reject(new WorkerUnavailableError());
      return;
    }
    if (!this.ensureWorker()) {
      // Spawn failed and tipped us over the ceiling → drain the queue in-thread.
      const err = new WorkerUnavailableError();
      for (const item of this.queue.splice(0)) item.reject(err);
      return;
    }
    const item = this.queue.shift()!;
    this.inFlight = item;
    try {
      this.worker!.postMessage({ type: 'job', content: item.content, ext: item.ext, loc: item.loc });
    } catch {
      // The worker died between ensureWorker() and postMessage — treat as a
      // spawn failure and retry (the caller falls back in-thread if we give up).
      this.inFlight = null;
      this.onWorkerDeath(item);
      return;
    }
    this.stall.arm();
  }

  // Returns false only when spawning failed AND the failure ceiling was hit.
  private ensureWorker(): boolean {
    if (this.worker) return true;
    if (this.isUnavailable()) return false;
    try {
      const w = this.createWorker({ analyzeUrl: this.analyzeUrl });
      this.worker = w;
      w.on('message', (m: WorkerMessage) => {
        if (w !== this.worker) return;
        this.onMessage(m);
      });
      w.on('error', () => {
        if (w !== this.worker) return;
        this.onWorkerDeath();
      });
      w.on('exit', () => {
        if (w !== this.worker) return;
        this.onWorkerDeath();
      });
      return true;
    } catch {
      this.spawnFailures += 1;
      if (this.spawnFailures >= MAX_SPAWN_FAILURES) this.giveUpForNow();
      return false;
    }
  }

  private onMessage(msg: WorkerMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init-failed') {
      // Compiled analyze.js not loadable (e.g. src under tsx). Permanently fall
      // back to in-thread for everything.
      if (process.env.LATTICE_HEALTH_DEBUG) {
        console.error('[health] isolated analyzer init failed:', msg.error);
      }
      this.permanentlyUnavailable = true;
      this.stall.clear();
      this.killWorker();
      const inFlight = this.inFlight;
      this.inFlight = null;
      const err = new WorkerUnavailableError();
      if (inFlight) inFlight.reject(err);
      for (const item of this.queue.splice(0)) item.reject(err);
      return;
    }
    if (msg.type === 'result') {
      this.stall.clear();
      const item = this.inFlight;
      this.inFlight = null;
      // A successful spawn+run resets the failure counter.
      this.spawnFailures = 0;
      if (item) {
        item.resolve(
          msg.ok ? { metrics: msg.metrics as HealthMetrics, imports: msg.imports ?? [] } : null,
        );
      }
      this.pump();
    }
  }

  private onStall(): void {
    const item = this.inFlight;
    this.inFlight = null;
    this.killWorker();
    console.warn(
      `[health] isolated analyzer exceeded ${this.stallMs}ms on a file — terminating ` +
        `the worker and skipping it (likely pathological input); the watcher continues.`,
    );
    // The hung file is unanalyzable → skip (resolve null). Queued jobs continue
    // on a freshly-spawned worker via pump().
    if (item) item.resolve(null);
    this.pump();
  }

  // Worker crashed/exited unexpectedly (NOT a watchdog kill — those go through
  // onStall and null out inFlight first). The interrupted job, if any, is retried
  // in-thread (reject); queued jobs continue on a respawn unless we give up.
  private onWorkerDeath(interrupted?: Pending): void {
    this.stall.clear();
    this.killWorker();
    this.spawnFailures += 1;
    if (this.spawnFailures >= MAX_SPAWN_FAILURES) this.giveUpForNow();
    const item = interrupted ?? this.inFlight;
    this.inFlight = null;
    if (item) item.reject(new WorkerUnavailableError());
    this.pump();
  }

  private killWorker(): void {
    if (this.worker) {
      terminateQuietly(this.worker);
      this.worker = null;
    }
  }
}

// Production singleton used by the watcher. Tests construct their own
// IsolatedAnalyzer with an injected worker factory.
const singleton = new IsolatedAnalyzer();

export function analyzeContentIsolated(
  content: string,
  ext: string,
  loc: number,
): Promise<IsolatedAnalysis | null> {
  return singleton.analyze(content, ext, loc);
}

export function disposeIsolatedAnalyzer(): void {
  singleton.dispose();
}
