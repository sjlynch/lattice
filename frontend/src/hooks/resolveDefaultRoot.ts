// Boot-time default-project loader with backoff retry.
//
// useActiveFolder calls fetchDefaultRoot() on a fresh tab while the backend may
// still be starting. A transient failure (a 502 from the dev proxy before
// :5184 is listening, or a parse error on an HTML error body) used to clear the
// active folder to '' permanently, stranding the user on a blank shell even
// though the backend came up a second later. This mirrors useProjectScan's
// scan-retry behaviour: keep retrying with exponential backoff, and only fall
// back to the empty 'pick a folder' shell after several attempts have failed.
//
// Kept React-free so it can be unit-tested directly (sleep is injectable).

import { APP_CONFIG } from '../appConfig';

// Total attempts (initial try + retries) before giving up and falling back to
// the empty shell. With APP_CONFIG.scanRetry's 300ms initial / ×2 / 5s cap,
// this spans ~19s of boot races before conceding the backend is genuinely down.
const DEFAULT_MAX_ATTEMPTS = 8;

export interface ResolveDefaultRootOptions {
  fetchRoot: () => Promise<string>;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  // Injectable so tests don't actually wait out the backoff.
  sleep?: (ms: number) => Promise<void>;
  // Lets the effect cleanup abort an in-flight retry loop on unmount.
  isCancelled?: () => boolean;
  onRetry?: (err: unknown, attempt: number) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves to the backend's default project root, or '' once retries are
// exhausted / the loop is cancelled — '' being the signal to fall back to the
// empty 'no project' shell. Never rejects.
export async function resolveDefaultRoot(
  opts: ResolveDefaultRootOptions,
): Promise<string> {
  const {
    fetchRoot,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    initialDelayMs = APP_CONFIG.scanRetry.initialDelayMs,
    maxDelayMs = APP_CONFIG.scanRetry.maxDelayMs,
    backoffFactor = APP_CONFIG.scanRetry.backoffFactor,
    sleep = defaultSleep,
    isCancelled = () => false,
    onRetry,
  } = opts;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (isCancelled()) return '';
    try {
      return await fetchRoot();
    } catch (err) {
      // Exhausted all attempts (or cancelled mid-flight) — concede and let the
      // caller drop to the empty shell.
      if (attempt === maxAttempts - 1 || isCancelled()) return '';
      onRetry?.(err, attempt);
      const delay = Math.min(maxDelayMs, initialDelayMs * backoffFactor ** attempt);
      await sleep(delay);
    }
  }
  return '';
}
