// Display-only activity polling. Unknown terminal state must never be used to
// kill a session or alter workflow/task lifecycle; it only expires a spinner.
type Listener = (busyIds: string[]) => void;
type Timer = ReturnType<typeof setInterval>;

export interface TerminalActivityPollerOptions {
  // Check isCurrent() after awaits before mutating any externally carried fold
  // state: a response may belong to a subscription generation that has ended.
  fetchBusy: (isCurrent: () => boolean) => Promise<string[] | null>;
  reset: () => void;
  now?: () => number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  setInterval?: (callback: () => void, delay: number) => Timer;
  clearInterval?: (timer: Timer) => void;
}

type Generation = {
  timer: Timer | null;
  inFlight: boolean;
  lastSuccessAt: number | null;
  busy: string[];
  key: string;
};

export function createTerminalActivityPoller(options: TerminalActivityPollerOptions): {
  subscribe: (listener: Listener) => () => void;
} {
  const now = options.now ?? Date.now;
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const intervalMs = options.pollIntervalMs ?? 1_000;
  const staleAfterMs = options.staleAfterMs ?? 5_000;
  // A separate entry per subscription lets the same callback subscribe twice.
  const listeners = new Set<{ listener: Listener }>();
  let current: Generation | null = null;

  function reset(): void {
    try { options.reset(); } catch { /* telemetry cannot break subscriptions */ }
  }

  function emit(listener: Listener, busy: string[]): void {
    try { listener([...busy]); } catch { /* isolate failed subscribers */ }
  }

  function publish(generation: Generation, busy: string[]): void {
    if (current !== generation) return;
    const normalized = [...new Set(busy)].sort();
    const key = JSON.stringify(normalized);
    if (key === generation.key) return;
    generation.busy = normalized;
    generation.key = key;
    for (const entry of [...listeners]) {
      if (current !== generation) break;
      if (listeners.has(entry)) emit(entry.listener, normalized);
    }
  }

  function expire(generation: Generation): void {
    if (generation.lastSuccessAt !== null &&
        now() - generation.lastSuccessAt >= staleAfterMs) {
      publish(generation, []);
    }
  }

  async function poll(generation: Generation): Promise<void> {
    if (current !== generation || generation.inFlight) return;
    generation.inFlight = true;
    const isCurrent = () => current === generation;
    try {
      const busy = await options.fetchBusy(isCurrent);
      if (!isCurrent()) return;
      if (busy === null) {
        expire(generation);
      } else {
        generation.lastSuccessAt = now();
        publish(generation, busy);
      }
    } catch {
      if (isCurrent()) expire(generation);
    } finally {
      generation.inFlight = false;
    }
  }

  function subscribe(listener: Listener): () => void {
    const entry = { listener };
    listeners.add(entry);
    const startsGeneration = current === null;
    if (startsGeneration) {
      current = { timer: null, inFlight: false, lastSuccessAt: null, busy: [], key: '[]' };
      reset();
      const generation = current;
      generation.timer = schedule(() => {
        if (current !== generation) return;
        // This runs even while a probe hangs, bounding stale display state.
        expire(generation);
        void poll(generation);
      }, intervalMs);
      generation.timer.unref?.();
    }
    const generation = current!;
    emit(listener, generation.busy);
    if (startsGeneration) void poll(generation);
    return () => {
      if (!listeners.delete(entry) || listeners.size !== 0) return;
      const ended = current;
      current = null;
      if (ended?.timer) cancel(ended.timer);
      reset();
    };
  }

  return { subscribe };
}
