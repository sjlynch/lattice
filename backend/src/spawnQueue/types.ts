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
  signal?: AbortSignal;
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
  // Set while the request is backing off after a disk-space deferral.
  waitingForDisk?: { reason: string; retryAt: number };
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

// Thrown by a thunk when creating its worktree would push the disk below the
// free-space reserve (worktree/diskSpace.ts). Like a CAP rejection it is NOT a
// failure: the queue re-queues the request, but with a per-request backoff
// (`retryAfterMs`) instead of freezing every admission — spawns that need no
// new disk (merge resolvers, resumes) keep flowing. `notifyDiskSpaceFreed`
// cuts the backoff short when a worktree cleanup frees space.
export class SpawnDiskSpaceError extends Error {
  readonly isSpawnDiskSpaceError = true;
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = 'SpawnDiskSpaceError';
  }
}

export function isSpawnDiskSpaceError(err: unknown): err is SpawnDiskSpaceError {
  return (
    err instanceof SpawnDiskSpaceError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { isSpawnDiskSpaceError?: unknown }).isSpawnDiskSpaceError === true)
  );
}

// Either deferral: the spawn was not attempted for lack of a resource and the
// queue will retry it. Callers outside the queue (runSpawnThunk, the workflow
// Start step) must treat both as "deferred", never as a failed start.
export function isSpawnDeferral(err: unknown): boolean {
  return isSpawnCapacityError(err) || isSpawnDiskSpaceError(err);
}
