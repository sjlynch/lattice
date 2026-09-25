// Pure concurrency accounting for the spawn queue. No I/O, no timers —
// every method is a deterministic state transition so the race-prone
// reconciliation logic can be unit-tested in isolation.
//
// The terminal-server is the single source of truth for the live session
// count (GET /sessions). Between polls the queue tracks `reserved` entries —
// one per admitted-but-not-yet-poll-confirmed spawn — and gates admission on
//
//   effectiveLive = liveCount + reserved.length
//
// `reconcile` folds an authoritative poll back in without double-counting a
// session that landed mid-poll (see the dropping rule below).
//
// The poll also reports how many of those sessions are Lattice AGENTS (see
// `countAgentSessions` in resourceGovernor.ts) — the resource governor's
// "never starve Lattice to zero" floor counts agents, not every pty
// (`effectiveAgents`).

import type { SpawnPriority } from './types.js';

export type ReservationStatus =
  // Admitted; the thunk's proxyCreateSession has not returned yet.
  | 'spawning'
  // proxyCreateSession returned a session id.
  | 'spawned';

export type Reservation = {
  id: number;
  admittedAt: number;
  status: ReservationStatus;
  // When the spawn resolved (status became 'spawned').
  resolvedAt?: number;
};

export class SpawnAccounting {
  private liveCount = 0;
  // The subset of `liveCount` that are Lattice agent sessions (task worktree
  // agents, resolvers, workflow steps, one-off runs) — not sidebar shells,
  // startup terminals or the user's own harness tabs.
  private liveAgentCount = 0;
  // false until the first successful poll: the queue never admits on an
  // unprimed/stale count.
  private pollHealthy = false;
  private reservations: Reservation[] = [];
  private nextId = 1;

  constructor(
    // softCap is mutable: the global setting `maxConcurrentAgents` can be
    // changed at runtime via PATCH /api/global-settings.
    private softCap: number,
    private readonly priorityReserve: number,
  ) {}

  // Update the concurrency governor. Lowering it below effectiveLive simply
  // stops new admissions until sessions free — live sessions are untouched.
  setSoftCap(softCap: number): void {
    this.softCap = Math.max(1, Math.floor(softCap));
  }

  getSoftCap(): number {
    return this.softCap;
  }

  // Reserve a slot for a spawn the drain just admitted.
  reserve(now: number): number {
    const id = this.nextId++;
    this.reservations.push({ id, admittedAt: now, status: 'spawning' });
    return id;
  }

  // The reserved spawn's proxyCreateSession returned a session.
  markSpawned(id: number, now: number): void {
    const r = this.reservations.find((x) => x.id === id);
    if (r) {
      r.status = 'spawned';
      r.resolvedAt = now;
    }
  }

  // Drop a reservation entirely — the spawn failed or was CAP-rejected, so
  // no session was created and the slot is free again.
  release(id: number): void {
    this.reservations = this.reservations.filter((x) => x.id !== id);
  }

  // Apply an authoritative session count from a poll that was *requested* at
  // `requestedAt`. Set liveCount to truth, then drop every reservation that
  // resolved before the request was sent — those sessions are definitely
  // included in `polledCount`, so keeping them reserved would double-count.
  // Still-`spawning` reservations, and ones that resolved after `requestedAt`
  // (poll may or may not have seen them), stay reserved: the safe direction
  // is a one-cycle under-admit, never an over-admit.
  //
  // `polledAgents` is how many of the polled sessions are Lattice agents;
  // omitted, every session counts as one.
  reconcile(polledCount: number, requestedAt: number, polledAgents: number = polledCount): void {
    this.liveCount = Math.max(0, Math.floor(polledCount));
    this.liveAgentCount = Math.min(this.liveCount, Math.max(0, Math.floor(polledAgents)));
    this.pollHealthy = true;
    this.reservations = this.reservations.filter(
      (r) =>
        !(
          r.status === 'spawned' &&
          r.resolvedAt !== undefined &&
          r.resolvedAt < requestedAt
        ),
    );
  }

  // A poll could not reach the terminal-server. Freeze admissions (keep the
  // last known liveCount) until a poll succeeds again.
  notePollFailure(): void {
    this.pollHealthy = false;
  }

  // The hard cap rejected a spawn the queue thought it had room for — our
  // count over-admitted. Freeze admissions until the next poll corrects
  // liveCount; without this the drain would instantly re-admit and re-fail.
  noteOverAdmit(): void {
    this.pollHealthy = false;
  }

  effectiveLive(): number {
    return this.liveCount + this.reservations.length;
  }

  // Lattice agents live or on their way: polled agent sessions plus every
  // reservation (each is a spawn the queue itself admitted). What the
  // resource governor's floor counts — a pile of sidebar shells or a
  // `npm run dev` terminal must not look like "Lattice already has agents".
  effectiveAgents(): number {
    return this.liveAgentCount + this.reservations.length;
  }

  getLiveAgentCount(): number {
    return this.liveAgentCount;
  }

  reservedCount(): number {
    return this.reservations.length;
  }

  getLiveCount(): number {
    return this.liveCount;
  }

  isPollHealthy(): boolean {
    return this.pollHealthy;
  }

  private capForBand(priority: SpawnPriority): number {
    return priority === 'batch'
      ? this.softCap
      : this.softCap + this.priorityReserve;
  }

  // Free slots for a band (may be negative if already over the cap).
  headroom(priority: SpawnPriority): number {
    return this.capForBand(priority) - this.effectiveLive();
  }

  // A spawn of this band may be admitted right now.
  canAdmit(priority: SpawnPriority): boolean {
    return this.pollHealthy && this.headroom(priority) > 0;
  }
}
