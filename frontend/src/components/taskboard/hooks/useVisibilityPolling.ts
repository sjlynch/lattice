import { useEffect, useRef } from 'react';
import { isLatticeHidden, onLatticeVisibilityChange } from '../../floatingPanel/popoutRegistry';

export type PollErrorSentinel = 'error';
export type PollResult<T> = T | PollErrorSentinel;

export function pollWithErrorSentinel<T>(
  request: () => Promise<T>,
): Promise<PollResult<T>> {
  return request().catch(() => 'error' as const);
}

type UseVisibilityPollingArgs = {
  enabled: boolean;
  intervalMs: number;
  poll: (isCancelled: () => boolean) => void | Promise<void>;
  immediateOnVisible?: boolean;
};

// Shared polling shell for task-board adjunct runs (push / QA e2e). It owns the
// lifecycle mechanics only: interval setup/teardown, pausing while every Lattice
// window is hidden (a popped-out board on another monitor keeps it running),
// resuming with an optional foreground tick, and a cancellation guard
// that async poll bodies can check before mutating state or closing terminals.
// `pollWithErrorSentinel` standardizes transient fetch failures as `'error'`;
// callers keep domain-specific completion and terminal cleanup decisions.
export function useVisibilityPolling({
  enabled,
  intervalMs,
  poll,
  immediateOnVisible = true,
}: UseVisibilityPollingArgs) {
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let handle: number | null = null;
    const isCancelled = () => cancelled;

    const run = () => {
      if (cancelled) return;
      void Promise.resolve(pollRef.current(isCancelled)).catch(() => {});
    };

    const start = () => {
      if (handle === null) handle = window.setInterval(run, intervalMs);
    };
    const stop = () => {
      if (handle !== null) {
        window.clearInterval(handle);
        handle = null;
      }
    };
    const onVisibility = () => {
      if (isLatticeHidden()) {
        stop();
        return;
      }
      if (immediateOnVisible) run();
      start();
    };

    if (!isLatticeHidden()) start();
    const stopVisibility = onLatticeVisibilityChange(onVisibility);
    return () => {
      cancelled = true;
      stop();
      stopVisibility();
    };
  }, [enabled, immediateOnVisible, intervalMs]);
}
