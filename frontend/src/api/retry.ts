// Retry-through-a-backend-restart for "start X" POSTs (workflow run, merge
// all, task run / resume). Lattice restarts its own backend whenever it merges
// a backend change into itself, so a click (or a queued workflow start) often
// lands in the few seconds the backend is down or still recovering. Those
// failures are not the user's problem: keep retrying with backoff instead of
// dropping the start and toasting a 502.
//
// Transient = the request never got a real answer:
//   - fetch TypeError  — the browser couldn't reach vite at all
//   - 502              — vite's proxy couldn't reach the backend (see
//                        frontend/vite.config.ts `endWithProxyError`)
//   - 503              — the backend answered "not ready" (e.g. workflow
//                        recovery still loading, `code: workflow-recovering`)
//   - 504              — gateway timeout
// Every other status (4xx, 500) is a real answer and is thrown immediately.

import { HttpError } from './http';

export const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

// Backoff: 1s, 2s, 4s, 8s, then every 15s, for up to 3 minutes in total — a
// backend rebuild + boot + recovery is typically 10–60 s.
export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 15_000;
export const RETRY_MAX_ELAPSED_MS = 3 * 60_000;

export function isTransientRequestError(err: unknown): boolean {
  if (err instanceof HttpError) return TRANSIENT_HTTP_STATUSES.has(err.status);
  // `fetch` rejects with a TypeError on a network failure. Anything else
  // thrown (a SyntaxError from a bad body, a bug) is not retried.
  return err instanceof TypeError;
}

// Could this failed attempt still have been APPLIED server-side? A 503 is the
// backend itself refusing before doing anything, and a 502 for ECONNREFUSED
// never reached it; a network error, a 504 or a 502 for a reset connection
// may have been processed with only the response lost. A caller that sees a
// 409 "already running" after such a failure should suspect its OWN earlier
// attempt rather than a foreign run.
export function mayHaveBeenApplied(err: unknown): boolean {
  if (err instanceof HttpError) {
    if (err.status === 503) return false;
    if (err.status === 502) return !/ECONNREFUSED/.test(err.message);
    return err.status === 504;
  }
  return err instanceof TypeError;
}

export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
}

export type RetryTransientOptions = {
  // Stop retrying (and throw the last error) once this returns true — e.g.
  // the user switched projects, so the start no longer belongs here.
  isCancelled?: () => boolean;
  // Called with each transient failure before the wait that follows it.
  onRetry?: (err: unknown, attempt: number) => void;
  maxElapsedMs?: number;
  // Injectable for tests.
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Runs `fn` until it resolves, throws a non-transient error, is cancelled, or
// the retry budget runs out. Always throws the most recent error on giving up.
export async function retryTransient<T>(
  fn: () => Promise<T>,
  options: RetryTransientOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const maxElapsed = options.maxElapsedMs ?? RETRY_MAX_ELAPSED_MS;
  const startedAt = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientRequestError(err)) throw err;
      if (options.isCancelled?.()) throw err;
      const delay = retryDelayMs(attempt);
      if (now() - startedAt + delay > maxElapsed) throw err;
      options.onRetry?.(err, attempt);
      await sleep(delay);
      if (options.isCancelled?.()) throw err;
    }
  }
}
