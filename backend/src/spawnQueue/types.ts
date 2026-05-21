// Shared types for the spawn-admission queue. No I/O — safe to import
// from the pure accounting module and the test suite.

// Admission bands. `batch` is gated at softCap; `priority` and `interactive`
// may dip into the PRIORITY_RESERVE headroom above softCap so an in-flight
// merge can always get its resolver even when batch slots are full.
export type SpawnPriority = 'batch' | 'priority' | 'interactive';

// A spawn unit. Doing the *whole* spawn (worktree setup + exactly one
// proxyCreateSession) inside the thunk is deliberate: it lets the queue
// pace the heavy git/file work, not just the pty allocation.
export type SpawnThunk<T = unknown> = () => Promise<T>;

export type EnqueueSpawnArgs<T = unknown> = {
  // Human-readable category for logs/snapshots ('task-run', 'task-resume', …).
  kind: string;
  priority: SpawnPriority;
  // Idempotency key. A second enqueue with a live key is a no-op that
  // returns the existing request's handle.
  dedupeKey: string;
  thunk: SpawnThunk<T>;
};

export type EnqueueSpawnResult<T = unknown> = {
  // false ⇒ admitted synchronously by the drain that ran inside enqueue.
  queued: boolean;
  // Resolves with the thunk result on success; rejects on a non-capacity
  // failure. A capacity rejection does NOT settle this — the request is
  // re-queued and retried, so `done` stays pending across CAP retries.
  done: Promise<T>;
};

export type SpawnQueueSnapshotItem = {
  kind: string;
  priority: SpawnPriority;
  dedupeKey: string;
  enqueuedAt: number;
  state: 'pending' | 'in-flight';
};

export type SpawnQueueSnapshot = {
  items: SpawnQueueSnapshotItem[];
  pending: number;
  inFlight: number;
  reserved: number;
  liveCount: number;
  effectiveLive: number;
  pollHealthy: boolean;
  softCap: number;
};

// Thrown by a thunk (or surfaced by the queue) when the terminal-server's
// hard cap rejected the spawn. The queue treats it as "no slot": release the
// reservation, freeze admissions until the next successful poll, and re-queue
// the request at the front of its band. It is NOT a failure — no spawn is
// ever lost to it.
export class SpawnCapacityError extends Error {
  readonly isSpawnCapacityError = true;
  constructor(message: string) {
    super(message);
    this.name = 'SpawnCapacityError';
  }
}

export function isSpawnCapacityError(err: unknown): err is SpawnCapacityError {
  return (
    err instanceof SpawnCapacityError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { isSpawnCapacityError?: unknown }).isSpawnCapacityError === true)
  );
}
