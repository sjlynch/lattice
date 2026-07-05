import { useRef } from 'react';
import { APP_CONFIG } from '../appConfig';

// Retry + request-id fencing utilities shared by the initial scan and the live
// rescan. `retryDelay` is the exponential-backoff math (capped by APP_CONFIG);
// `useRequestIdFence` hands out monotonic ids so a slow in-flight scan whose
// state has since moved on (project switch, newer rescan) can detect that it's
// stale via `isCurrent` and bail instead of clobbering fresher results.

export function retryDelay(attempt: number): number {
  return Math.min(
    APP_CONFIG.scanRetry.maxDelayMs,
    APP_CONFIG.scanRetry.initialDelayMs
      * APP_CONFIG.scanRetry.backoffFactor ** attempt,
  );
}

export type RequestIdFence = {
  // Claim the next request id; the caller holds it and re-checks `isCurrent`
  // when its async work resolves.
  next: () => number;
  // True only while `requestId` is still the most recently claimed id.
  isCurrent: (requestId: number) => boolean;
};

export function useRequestIdFence(): RequestIdFence {
  const requestIdRef = useRef(0);
  const apiRef = useRef<RequestIdFence>({
    next: () => {
      requestIdRef.current += 1;
      return requestIdRef.current;
    },
    isCurrent: (requestId: number) => requestId === requestIdRef.current,
  });
  return apiRef.current;
}
