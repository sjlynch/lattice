// The /sessions poll loop. The terminal-server is the authoritative session
// count; this folds it into the accounting and re-drains. The loop runs
// ONLY while the queue has pending or reserved work — zero cost when idle.

import { proxyListSessionsOrNull } from '../terminalProxy.js';
import { SPAWN_QUEUE_CONFIG } from './config.js';
import { drainQueue } from './drain.js';
import { countAgentSessions } from './resourceGovernor.js';
import { queueState } from './state.js';

let pollTimer: NodeJS.Timeout | null = null;
let pollInProgress = false;

// One poll: snapshot the time, ask the terminal-server, reconcile, drain.
// The listing (not just a count) is fetched so the resource governor's floor
// can count Lattice agent sessions apart from shells / startup terminals.
export async function pollOnce(): Promise<void> {
  const requestedAt = Date.now();
  const sessions = await proxyListSessionsOrNull();
  if (sessions === null) {
    // terminal-server unreachable — freeze admissions, keep the last count.
    queueState.accounting.notePollFailure();
    return;
  }
  queueState.accounting.reconcile(sessions.length, requestedAt, countAgentSessions(sessions));
  drainQueue();
}

// Start the poll loop if there is work and it is not already running.
// Idempotent — safe to call on every enqueue.
export function ensurePolling(): void {
  if (pollTimer || !queueState.hasWork()) return;
  pollTimer = setInterval(() => {
    void pollTick();
  }, SPAWN_QUEUE_CONFIG.pollIntervalMs);
  // Never let the poll loop alone keep the process alive.
  pollTimer.unref();
}

// Run one poll now, out of band from the interval. Used by
// `notifySessionsFreed` so a backend-owned kill's freed slot is reused
// immediately instead of waiting up to one poll interval. Guarded against
// overlapping with an in-flight poll.
export function pokePoll(): void {
  void pollTick();
}

async function pollTick(): Promise<void> {
  // Skip if a slow poll from the previous tick is still in flight.
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    await pollOnce();
  } finally {
    pollInProgress = false;
  }
  // Stop once the queue is fully drained — restarted by the next enqueue.
  if (pollTimer && !queueState.hasWork()) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
