// Spawn-admission queue — public facade.
//
// Backend-side admission controller fronting every agent spawn. When
// concurrent spawns would exceed the machine-global softCap, the spawn is
// DEFERRED in a queue instead of being rejected — so requested work is never
// dropped. The terminal-server's MAX_TERMINAL_SESSIONS hard cap stays as a
// pure runaway backstop.
//
// Implementation is split under spawnQueue/ (mirrors the mergeRuns.ts +
// mergeRuns/ convention). See spawnQueue/CLAUDE.md for the contract.

import { getGlobalSettings } from './globalSettings.js';
import { drainQueue } from './spawnQueue/drain.js';
import { ensurePolling, pokePoll, pollOnce } from './spawnQueue/poll.js';
import { queueState } from './spawnQueue/state.js';
import type {
  EnqueueSpawnArgs,
  EnqueueSpawnResult,
  SpawnQueueSnapshot,
} from './spawnQueue/types.js';

export {
  SpawnCapacityError,
  SpawnDiskSpaceError,
  isSpawnCapacityError,
  isSpawnDeferral,
  isSpawnDiskSpaceError,
} from './spawnQueue/types.js';
export type {
  SpawnPriority,
  SpawnThunk,
  EnqueueSpawnArgs,
  EnqueueSpawnResult,
  SpawnQueueSnapshot,
} from './spawnQueue/types.js';

// Enqueue a spawn. The thunk does the FULL spawn unit (setup + exactly one
// proxyCreateSession) and runs only when the queue has headroom. `done`
// resolves with the thunk result; HTTP routes ignore it (delivery is via WS)
// while blocking callers (the merge worker, Phase 2) await it.
export function enqueueSpawn<T>(
  args: EnqueueSpawnArgs<T>,
): EnqueueSpawnResult<T> {
  const { request, isNew } = queueState.addOrGet(args);
  if (isNew) {
    ensurePolling();
    drainQueue();
  }
  return {
    queued: request.state === 'pending',
    done: request.done as Promise<T>,
  };
}

// Cancel a still-pending spawn (e.g. its task was deleted). An already
// in-flight spawn cannot be cancelled — it completes and is cleaned up by
// the normal task-delete path. Returns true if a pending request was removed.
export function cancelSpawn(dedupeKey: string): boolean {
  const request = queueState.get(dedupeKey);
  if (!request || request.state !== 'pending') return false;
  queueState.remove(dedupeKey);
  request.reject(new Error(`spawn cancelled (${dedupeKey})`));
  return true;
}

// Hint that backend-owned kills just freed pty slots. If the queue has
// deferred work, run an out-of-band poll so the freed capacity is picked up
// immediately rather than up to one poll interval later. A no-op when nothing
// is waiting (the freed slot simply stays free).
export function notifySessionsFreed(): void {
  if (queueState.pendingCount() === 0) return;
  pokePoll();
}

// Hint that disk space was just freed (a worktree was removed, a merge
// finalized). Cut every disk-deferred request's backoff short and drain, so a
// run waiting on space starts as soon as a merge makes room rather than up to
// one backoff later. A no-op when nothing is waiting on disk.
export function notifyDiskSpaceFreed(): void {
  let any = false;
  for (const r of queueState.pendingSorted()) {
    if (r.waitingForDisk) {
      r.waitingForDisk = { ...r.waitingForDisk, retryAt: 0 };
      any = true;
    }
  }
  if (any) drainQueue();
}

export function getSpawnQueueSnapshot(): SpawnQueueSnapshot {
  return queueState.snapshot();
}

// Update the concurrency governor (softCap) at runtime — called by
// PATCH /api/global-settings. Raising it creates headroom, so drain any
// deferred spawns into it immediately.
export function setSpawnQueueSoftCap(softCap: number): void {
  queueState.accounting.setSoftCap(softCap);
  drainQueue();
}

// Toggle the CPU/RAM brake on batch admission (spawnQueue/resourceGovernor.ts).
export function setSpawnQueueResourceGovernor(enabled: boolean): void {
  queueState.governor.setEnabled(enabled);
  drainQueue();
}

// Boot hook: apply the persisted softCap from global settings, then prime
// the accounting with one /sessions poll so the first enqueue after startup
// admits immediately instead of waiting a poll cycle. Best-effort — if the
// terminal-server is briefly unreachable the first enqueue simply waits for
// the poll loop to succeed.
export async function startSpawnQueue(): Promise<void> {
  try {
    const settings = await getGlobalSettings();
    queueState.accounting.setSoftCap(settings.maxConcurrentAgents);
    queueState.governor.setEnabled(settings.resourceGovernor !== false);
  } catch (err) {
    console.error(
      '[spawn-queue] could not load global settings; using default softCap:',
      err,
    );
  }
  await pollOnce();
}
