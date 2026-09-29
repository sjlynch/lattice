import { proxyListSessionsOrNull } from '../../terminalServerClient.js';
import { findStepSessionId, type ProbedSession } from '../../workflowRuns/resumeDecision.js';
import {
  LOST_SETTLE_GRACE_MS,
  ONE_OFF_WATCH_INTERVAL_MS,
  type AnyRun,
  type OneOffResumeDeps,
  type OneOffRunKind,
  type Watched,
} from './contracts.js';

const watched = new Map<string, Watched>();
let watchTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

function watchKey(kind: OneOffRunKind, id: string): string {
  return `${kind}:${id}`;
}

function sessionAlive(sessions: readonly ProbedSession[], run: AnyRun): boolean {
  return findStepSessionId(sessions, run.cwd) !== null;
}

export function watchOneOffRun(entry: Watched): void {
  watched.set(watchKey(entry.kind, entry.run.id), entry);
}

export function ensureWatch(): void {
  if (watchTimer || watched.size === 0) return;
  watchTimer = setInterval(() => void runOneOffRunWatchTick(), ONE_OFF_WATCH_INTERVAL_MS);
  watchTimer.unref?.();
}

function stopWatchIfIdle(): void {
  if (watched.size > 0 || !watchTimer) return;
  clearInterval(watchTimer);
  watchTimer = null;
}

// One pass of the liveness watch. Exported for tests.
export async function runOneOffRunWatchTick(deps: OneOffResumeDeps = {}): Promise<void> {
  if (ticking) return;
  if (watched.size === 0) {
    stopWatchIfIdle();
    return;
  }
  ticking = true;
  try {
    const sessions = (await (deps.listSessions ?? proxyListSessionsOrNull)()) as ProbedSession[] | null;
    // Can't tell ≠ gone: never settle on an unreachable terminal-server.
    if (sessions === null) return;
    const now = (deps.now ?? Date.now)();
    for (const [key, entry] of [...watched]) {
      if (!entry.isRunning()) {
        // Its own callback (or a replay from the outbox) settled it.
        watched.delete(key);
        continue;
      }
      if (sessionAlive(sessions, entry.run)) {
        entry.goneSince = undefined;
        continue;
      }
      if (entry.goneSince === undefined) {
        entry.goneSince = now;
        entry.reason = 'terminal exited without calling back';
      }
      if (now - entry.goneSince < LOST_SETTLE_GRACE_MS) continue;
      watched.delete(key);
      console.warn(
        `[startup] ${entry.noun} ${entry.run.id} (${entry.run.projectPath}): ${entry.reason} — settling it as lost.`,
      );
      await entry
        .settleLost(entry.reason)
        .catch((err) => console.warn(`[startup] ${entry.noun} ${entry.run.id}: settle failed:`, err));
    }
  } finally {
    ticking = false;
    stopWatchIfIdle();
  }
}

// Test seam: forget every watched run and stop the timer.
export function resetOneOffRunWatch(): void {
  watched.clear();
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}

export function watchedOneOffRunIds(): string[] {
  return [...watched.keys()];
}
