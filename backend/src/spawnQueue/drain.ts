// The drain: admit as many pending spawns as the accounting allows, then
// run each admitted thunk and fold its outcome back into the accounting.
//
// Non-reentrant — a thunk completing can trigger another drain, and the
// drain itself never blocks on a thunk (admitted thunks run detached).

import { queueState, type QueueRequest } from './state.js';
import { isSpawnCapacityError, isSpawnDiskSpaceError } from './types.js';

export function drainQueue(): void {
  const s = queueState;
  if (s.isDraining) {
    // A drain is already on the stack; ask it to re-scan once it unwinds.
    s.drainAgain = true;
    return;
  }
  s.isDraining = true;
  try {
    admitWhilePossible();
  } finally {
    s.isDraining = false;
  }
  if (s.drainAgain) {
    s.drainAgain = false;
    drainQueue();
  }
}

function admitWhilePossible(): void {
  const s = queueState;
  // Re-scan after every admission: a reservation shrinks headroom, so a
  // batch item can stop being admittable while a priority item still is.
  const now = Date.now();
  for (;;) {
    const next = s
      .pendingSorted()
      .find((r) => !isBackingOff(r, now) && s.accounting.canAdmit(r.priority));
    if (!next) break;
    admit(next);
  }
}

// A disk-deferred request sits out its backoff; the poll loop (which keeps
// running while any request is queued) re-drains once `retryAt` passes.
function isBackingOff(request: QueueRequest, now: number): boolean {
  return !!request.waitingForDisk && request.waitingForDisk.retryAt > now;
}

function admit(request: QueueRequest): void {
  const reservationId = queueState.accounting.reserve(Date.now());
  request.state = 'in-flight';
  request.reservationId = reservationId;
  // Detached on purpose — the drain admits up to headroom in one pass and
  // does not wait on any single spawn.
  void runThunk(request, reservationId);
}

async function runThunk(
  request: QueueRequest,
  reservationId: number,
): Promise<void> {
  const s = queueState;
  try {
    const result = await request.thunk();
    if (request.waitingForDisk) {
      console.log(`[spawn-queue] ${request.kind} (${request.dedupeKey}) had enough disk space on retry — started`);
    }
    s.accounting.markSpawned(reservationId, Date.now());
    s.remove(request.dedupeKey);
    request.resolve(result);
    // No slot freed (the reservation becomes a real session, reconciled by
    // a later poll), so no re-drain is needed here.
  } catch (err) {
    if (isSpawnDiskSpaceError(err) && !request.signal?.aborted) {
      // Not enough disk for another worktree. Nothing was created: free the
      // slot and back THIS request off. Unlike CAP, admissions are not frozen
      // — a spawn that needs no new disk (resolver, resume) may still run.
      s.accounting.release(reservationId);
      const firstDeferral = !request.waitingForDisk;
      request.state = 'pending';
      request.reservationId = undefined;
      request.waitingForDisk = { reason: err.message, retryAt: Date.now() + err.retryAfterMs };
      if (firstDeferral) {
        console.warn(
          `[spawn-queue] ${request.kind} (${request.dedupeKey}) waiting for disk space — ${err.message}`,
        );
      }
      drainQueue();
    } else if (isSpawnCapacityError(err) && !request.signal?.aborted) {
      // The hard cap rejected the spawn — the queue over-admitted. No
      // session was created: free the reservation, freeze admissions until
      // the next poll corrects liveCount, and re-queue the request. Its
      // original enqueuedAt keeps it at the front of its band.
      s.accounting.release(reservationId);
      s.accounting.noteOverAdmit();
      request.state = 'pending';
      request.reservationId = undefined;
      console.warn(
        `[spawn-queue] ${request.kind} (${request.dedupeKey}) hit the hard cap — re-queued, backing off one poll cycle`,
      );
      // Deliberately no drainQueue() here: admissions are frozen until the
      // next successful poll, which will unfreeze and drain.
    } else {
      // A genuine failure (worktree setup threw, terminal-server wedged,
      // task no longer 'open', …). No session was created — free the slot,
      // settle `done` as a rejection, and let the next item use the slot.
      s.accounting.release(reservationId);
      s.remove(request.dedupeKey);
      request.reject(err);
      console.error(
        `[spawn-queue] ${request.kind} (${request.dedupeKey}) thunk failed:`,
        err,
      );
      drainQueue();
    }
  }
}
