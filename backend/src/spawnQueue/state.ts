// In-memory spawn-queue state: the request registry, dedupe index, the
// SpawnAccounting instance, and the non-reentrant-drain flags. Pure data
// structure — no timers, no thunk execution (that lives in drain.ts).

import { SpawnAccounting } from './accounting.js';
import { SPAWN_QUEUE_CONFIG } from './config.js';
import type {
  EnqueueSpawnArgs,
  SpawnPriority,
  SpawnQueueSnapshot,
  SpawnThunk,
} from './types.js';

export type QueueRequest = {
  id: number;
  kind: string;
  priority: SpawnPriority;
  dedupeKey: string;
  thunk: SpawnThunk;
  signal?: AbortSignal;
  // Original enqueue time; preserved across CAP re-queues so a retried
  // request naturally re-sorts to the front of its band.
  enqueuedAt: number;
  state: 'pending' | 'in-flight';
  // Disk-space backoff: not admitted before `retryAt` (see drain.ts).
  waitingForDisk?: { reason: string; retryAt: number };
  reservationId?: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  done: Promise<unknown>;
};

// Bands drain priority/interactive ahead of batch. They are low-volume and
// bounded, so batch is never starved for long (see plan §10).
function bandRank(priority: SpawnPriority): number {
  return priority === 'batch' ? 1 : 0;
}

export class SpawnQueueState {
  readonly accounting = new SpawnAccounting(
    SPAWN_QUEUE_CONFIG.softCap,
    SPAWN_QUEUE_CONFIG.priorityReserve,
  );

  isDraining = false;
  drainAgain = false;

  private readonly requests = new Map<string, QueueRequest>();
  private nextId = 1;

  // Add a request, or return the existing one for a live dedupeKey.
  addOrGet(args: EnqueueSpawnArgs): { request: QueueRequest; isNew: boolean } {
    const existing = this.requests.get(args.dedupeKey);
    if (existing) return { request: existing, isNew: false };

    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const done = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const request: QueueRequest = {
      id: this.nextId++,
      kind: args.kind,
      priority: args.priority,
      dedupeKey: args.dedupeKey,
      thunk: args.thunk,
      signal: args.signal,
      enqueuedAt: Date.now(),
      state: 'pending',
      resolve,
      reject,
      done,
    };
    this.requests.set(args.dedupeKey, request);
    return { request, isNew: true };
  }

  get(dedupeKey: string): QueueRequest | undefined {
    return this.requests.get(dedupeKey);
  }

  remove(dedupeKey: string): void {
    this.requests.delete(dedupeKey);
  }

  // Pending requests, highest band first then oldest-enqueued first.
  pendingSorted(): QueueRequest[] {
    const pending: QueueRequest[] = [];
    for (const r of this.requests.values()) {
      if (r.state === 'pending') pending.push(r);
    }
    pending.sort(
      (a, b) =>
        bandRank(a.priority) - bandRank(b.priority) ||
        a.enqueuedAt - b.enqueuedAt,
    );
    return pending;
  }

  pendingCount(): number {
    let n = 0;
    for (const r of this.requests.values()) if (r.state === 'pending') n++;
    return n;
  }

  inFlightCount(): number {
    let n = 0;
    for (const r of this.requests.values()) if (r.state === 'in-flight') n++;
    return n;
  }

  // True while there is work the poll loop must keep watching.
  hasWork(): boolean {
    return this.requests.size > 0 || this.accounting.reservedCount() > 0;
  }

  snapshot(): SpawnQueueSnapshot {
    const items = [...this.requests.values()].map((r) => ({
      kind: r.kind,
      priority: r.priority,
      dedupeKey: r.dedupeKey,
      enqueuedAt: r.enqueuedAt,
      state: r.state,
      ...(r.waitingForDisk ? { waitingForDisk: { ...r.waitingForDisk } } : {}),
    }));
    return {
      items,
      pending: this.pendingCount(),
      inFlight: this.inFlightCount(),
      reserved: this.accounting.reservedCount(),
      liveCount: this.accounting.getLiveCount(),
      effectiveLive: this.accounting.effectiveLive(),
      pollHealthy: this.accounting.isPollHealthy(),
      softCap: this.accounting.getSoftCap(),
    };
  }
}

// Process-wide singleton. The queue is in-memory by design; durability for
// task runs comes from the persisted `runQueued` flag + boot reconcile.
export const queueState = new SpawnQueueState();
