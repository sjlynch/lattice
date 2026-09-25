// In-memory spawn-queue state: the request registry, dedupe index, the
// SpawnAccounting instance, and the non-reentrant-drain flags. Pure data
// structure — no timers, no thunk execution (that lives in drain.ts).

import { SpawnAccounting } from './accounting.js';
import { SPAWN_QUEUE_CONFIG } from './config.js';
import { ResourceGovernor } from './resourceGovernor.js';
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
  // The request's own cancellation: `cancelSpawn` aborts it (pending or in
  // flight), and an external `EnqueueSpawnArgs.signal` is forwarded into it.
  // An aborted request is never re-queued by a CAP / disk deferral.
  controller: AbortController;
  signal: AbortSignal;
  // Detach the forwarding listener from the external signal (on settle).
  detachExternal?: () => void;
  // A cancelled request still running its thunk when the same dedupeKey was
  // enqueued again. This request is not admitted until that one settles, so
  // two thunks for one key (e.g. two checkouts of one task's worktree) never
  // run at once.
  predecessor?: QueueRequest;
  // Set once the request has left the queue for good (resolved / rejected).
  settled: boolean;
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

  readonly governor = new ResourceGovernor();

  isDraining = false;
  drainAgain = false;

  private readonly requests = new Map<string, QueueRequest>();
  // Cancelled in-flight requests whose dedupeKey a newer request took over
  // (see addOrGet). Still running their thunk, so still counted in flight.
  private readonly superseded = new Set<QueueRequest>();
  private nextId = 1;

  // Add a request, or return the existing one for a live dedupeKey. A
  // cancelled (aborted) request no longer dedupes a new enqueue: a pending one
  // is dropped, and an in-flight one is superseded — the new request takes the
  // key and waits for the old thunk to settle before it can be admitted.
  addOrGet(args: EnqueueSpawnArgs): { request: QueueRequest; isNew: boolean } {
    const existing = this.requests.get(args.dedupeKey);
    if (existing && !existing.signal.aborted) return { request: existing, isNew: false };
    let predecessor: QueueRequest | undefined;
    if (existing?.state === 'pending') {
      this.settle(existing);
      existing.reject(new Error(`spawn cancelled (${existing.dedupeKey})`));
    } else if (existing) {
      this.requests.delete(existing.dedupeKey);
      this.superseded.add(existing);
      predecessor = existing;
    }

    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const done = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const controller = new AbortController();
    const external = args.signal;
    let detachExternal: (() => void) | undefined;
    if (external?.aborted) {
      controller.abort(external.reason);
    } else if (external) {
      const forward = () => controller.abort(external.reason);
      external.addEventListener('abort', forward, { once: true });
      detachExternal = () => external.removeEventListener('abort', forward);
    }
    const request: QueueRequest = {
      id: this.nextId++,
      kind: args.kind,
      priority: args.priority,
      dedupeKey: args.dedupeKey,
      thunk: args.thunk,
      controller,
      signal: controller.signal,
      detachExternal,
      predecessor,
      settled: false,
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

  // Take a request out of the queue for good. Identity-checked: a superseded
  // request settling late must not evict the newer request holding its key.
  // Returns true when the request had been superseded (a successor may now be
  // admittable, so the caller should drain).
  settle(request: QueueRequest): boolean {
    request.settled = true;
    request.detachExternal?.();
    request.detachExternal = undefined;
    if (this.requests.get(request.dedupeKey) === request) {
      this.requests.delete(request.dedupeKey);
    }
    return this.superseded.delete(request);
  }

  // Not admittable yet: a cancelled request for the same key is still running.
  isWaitingOnPredecessor(request: QueueRequest): boolean {
    return !!request.predecessor && !request.predecessor.settled;
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
    let n = this.superseded.size;
    for (const r of this.requests.values()) if (r.state === 'in-flight') n++;
    return n;
  }

  // True while there is work the poll loop must keep watching.
  hasWork(): boolean {
    return (
      this.requests.size > 0 ||
      this.superseded.size > 0 ||
      this.accounting.reservedCount() > 0
    );
  }

  snapshot(): SpawnQueueSnapshot {
    const items = [...this.superseded, ...this.requests.values()].map((r) => ({
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
      governor: this.governor.state(),
    };
  }
}

// Process-wide singleton. The queue is in-memory by design; durability for
// task runs comes from the persisted `runQueued` flag + boot reconcile.
export const queueState = new SpawnQueueState();
