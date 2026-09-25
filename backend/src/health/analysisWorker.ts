// Shared plumbing for the two modules that run the tree-sitter health analysis
// in an eval'd WORKER THREAD behind a per-file stall watchdog:
//
//   - `scanner/healthWorkerRunner.ts` — per-scan batch runner (`runHealthAnalysis`)
//   - `health/watcher/isolatedAnalyze.ts` — the watcher's warm persistent worker
//     (`IsolatedAnalyzer`)
//
// Only the mechanical primitives live here. Each caller keeps its own
// WORKER_SRC, message protocol, respawn/give-up policy and public API — and its
// own choice of whether the worker and the stall timer are `unref()`'d (the
// watcher's warm worker is; the scan runner's is not), hence the `unref`
// options rather than one fixed behaviour.

import { Worker } from 'node:worker_threads';

// Per-file stall ceiling. Generous — a healthy file (AST work is capped at 1 MB,
// the regexes are linear) finishes in well under a second, including first-file
// WASM init — so the watchdog only trips on a file that genuinely hangs.
export const DEFAULT_ANALYSIS_STALL_MS = 10_000;

// Minimal structural view of a worker so tests can inject a fake without a real
// thread. `node:worker_threads`' Worker satisfies this; callers extend it with
// whatever else their protocol needs (e.g. `postMessage`).
export type AnalysisWorkerHandle = {
  on(event: 'message' | 'error' | 'exit', cb: (arg: any) => void): unknown;
  terminate(): unknown;
};

// Spawn an inline-eval worker from a source string (no separate file to
// compile/ship).
export function spawnEvalWorker(src: string, workerData: unknown, opts: { unref?: boolean } = {}): Worker {
  // execArgv: [] so the worker never inherits a TS-loader (`--import tsx`, …)
  // from the parent's exec args. The repo has repeatedly been bitten by loader
  // injection propagating into child processes (see backend/scripts/dev.mjs).
  const w = new Worker(src, { eval: true, workerData, execArgv: [] });
  if (opts.unref) w.unref();
  return w;
}

// Terminate a worker, swallowing any throw (it may already be dead). The caller
// nulls its own reference afterwards.
export function terminateQuietly(handle: AnalysisWorkerHandle | null): void {
  if (!handle) return;
  try {
    handle.terminate();
  } catch {
    /* ignore */
  }
}

export type StallTimer = {
  // (Re)start the watchdog: clears any pending timer, then schedules `onStall`.
  arm(): void;
  clear(): void;
};

export function createStallTimer(ms: number, onStall: () => void, opts: { unref?: boolean } = {}): StallTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (): void => {
    clear();
    timer = setTimeout(onStall, ms);
    if (opts.unref) timer.unref?.();
  };
  return { arm, clear };
}
