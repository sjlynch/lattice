// The JS-fallback content grep for search.ts: runs read + `re.test` over the
// collected source files inside a worker thread with a wall-clock budget, so a
// catastrophic user regex (ReDoS) can never freeze the main event loop.

import { Worker } from 'node:worker_threads';
import type { SearchResult } from '../search.js';
import { CANCEL_POLL_MS } from './constants.js';

export type BoundedGrepOptions = {
  source: string;
  limit: number;
  maxFileBytes: number;
  concurrency: number;
  budgetMs: number;
  isCancelled?: () => boolean;
};

// Leading bytes of each file checked for a NUL (the worker's cheap binary guard).
const BINARY_SNIFF_BYTES = 8192;

// Runs the JS grep (read + `re.test` each file) inside a worker thread so a
// catastrophic user regex can only block the worker's thread — the main thread
// enforces `budgetMs` and terminates the worker on overrun, returning whatever
// matched so far (truncated). This is the ReDoS containment: without the worker
// a single `re.test` on the event loop is uninterruptible and would hang the
// whole backend. The worker is an inline `eval` string (not a separate file) so
// resolution is identical under `tsc`/dist and under tsx (tests) — no `.js` vs
// `.ts` sibling to locate.
export function runBoundedJsGrep(
  files: string[],
  opts: BoundedGrepOptions,
): Promise<SearchResult> {
  return new Promise<SearchResult>((resolve, reject) => {
    const matches: string[] = [];
    let settled = false;
    let budgetTimer: ReturnType<typeof setTimeout>;
    let cancelTimer: ReturnType<typeof setInterval>;

    const worker = new Worker(JS_GREP_WORKER_SRC, {
      eval: true,
      workerData: {
        files,
        source: opts.source,
        limit: opts.limit,
        maxFileBytes: opts.maxFileBytes,
        concurrency: opts.concurrency,
      },
    });

    const cleanup = (): void => {
      clearTimeout(budgetTimer);
      clearInterval(cancelTimer);
      void worker.terminate();
    };
    const finish = (result: SearchResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    budgetTimer = setTimeout(() => {
      console.warn(
        `[search] JS grep exceeded ${opts.budgetMs}ms budget — terminating worker ` +
          `(pattern too slow / catastrophic backtracking); returning ${matches.length} partial match(es)`,
      );
      finish({ matches, scanned: matches.length, truncated: true });
    }, opts.budgetMs);

    cancelTimer = setInterval(() => {
      if (opts.isCancelled?.()) {
        // Client gave up; the route ignores the result but stop the work.
        finish({ matches, scanned: matches.length, truncated: false });
      }
    }, CANCEL_POLL_MS);

    worker.on(
      'message',
      (msg: { type: string; file?: string; scanned?: number; truncated?: boolean }) => {
        if (msg.type === 'match') {
          if (msg.file) matches.push(msg.file);
        } else if (msg.type === 'done') {
          finish({
            matches,
            scanned: msg.scanned ?? matches.length,
            truncated: !!msg.truncated,
          });
        }
      },
    );
    worker.on('error', (err) =>
      fail(err instanceof Error ? err : new Error(String(err))),
    );
    worker.on('exit', () => {
      // The worker stays alive until we terminate it (see the keep-alive
      // listener in JS_GREP_WORKER_SRC), so a not-yet-settled exit means it
      // died unexpectedly — resolve with whatever we have rather than hang.
      if (!settled) finish({ matches, scanned: matches.length, truncated: true });
    });
  });
}

// Worker body (plain JS, run via `new Worker(code, { eval: true })`). Mirrors
// the original main-thread read pool, but any hang is contained to this thread.
export const JS_GREP_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');

// Keep the worker alive after it finishes so the PARENT decides when it exits
// (a message listener refs the port) — avoids a done/exit delivery race.
parentPort.on('message', () => {});

const { files, source, limit, maxFileBytes, concurrency } = workerData;
const re = new RegExp(source, 'i');

let scanned = 0;
let matched = 0;
let truncated = false;
let cursor = 0;
let stopped = false;

async function worker() {
  for (;;) {
    // Truncation needs a (limit+1)th MATCH, same as the rg path — not merely
    // "limit reached": a worker looping back after the last file's match used
    // to report truncated for a result that was exactly complete.
    if (stopped) return;
    const i = cursor++;
    if (i >= files.length) return;
    const file = files[i];
    try {
      const stat = await fs.promises.stat(file);
      if (stat.size > maxFileBytes) continue;
      const buf = await fs.promises.readFile(file);
      // Cheap binary guard: a NUL byte in the first 8 KB means it's not text.
      if (buf.subarray(0, ${BINARY_SNIFF_BYTES}).includes(0)) continue;
      scanned++;
      // The one unbounded step: a catastrophic user regex blocks THIS thread,
      // and the parent's wall-clock budget terminates us — the main event loop
      // stays responsive throughout.
      if (re.test(buf.toString('utf8'))) {
        if (matched >= limit) { truncated = true; stopped = true; return; }
        matched++;
        parentPort.postMessage({ type: 'match', file });
      }
    } catch (_) {
      // Unreadable / vanished file — skip it.
    }
  }
}

(async () => {
  const pool = Math.min(concurrency, files.length) || 1;
  await Promise.all(Array.from({ length: pool }, () => worker()));
  parentPort.postMessage({ type: 'done', scanned, truncated });
})();
`;
