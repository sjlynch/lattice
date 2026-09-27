// Detects which agent CLIs (`claude`, `pi`, `codex`) are on PATH so the UI
// can hide options that wouldn't actually run. Probed lazily; a DEFINITIVE
// result (every probe exited) is cached for the server session — the set of
// installed CLIs doesn't change — but a timed-out or failed-to-spawn probe is
// "unknown" and is never memoized: at boot `where.exe` races tsc, the health
// scan and AV, and caching that as "not installed" hid the harness (and
// skipped the Pi sub-agent / Pi MCP installs) until a backend restart. An
// unknown result reports the harness unavailable for that response and
// schedules a background re-probe; `onHarnessAvailabilityChange` listeners
// (the `/ws/harnesses` sockets, the Pi installers) hear the corrected snapshot.

import { spawn } from 'node:child_process';
import { ALL_AGENT_HARNESSES, type AgentHarness } from './harnesses.js';

export type HarnessAvailability = Record<AgentHarness, boolean>;

// true = on PATH, false = the probe exited non-zero (definitive "not found"),
// 'unknown' = the probe timed out or could not be spawned (transient).
type ProbeResult = boolean | 'unknown';

// Max time to wait on the `where`/`which` PATH probe before giving up on it.
const HARNESS_PROBE_TIMEOUT_MS = 5000;
// Background re-probe delays after an unknown result (then stop; any later
// on-demand call still re-probes, since unknowns are never cached).
const REPROBE_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

type SpawnFn = typeof spawn;
let spawnImpl: SpawnFn = spawn;

let cached: Promise<HarnessAvailability> | null = null;
let inflight: Promise<HarnessAvailability> | null = null;
// Bumped by resetHarnessCache so a probe started before the reset can't
// repopulate the cache or the snapshot afterwards.
let generation = 0;
let lastSnapshot: HarnessAvailability | null = null;
let reprobeTimer: ReturnType<typeof setTimeout> | null = null;
let reprobeAttempt = 0;
const listeners = new Set<(avail: HarnessAvailability) => void>();

function isOnPath(cmd: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnImpl(probe, [cmd], { shell: false, windowsHide: true });
    } catch {
      finish('unknown');
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish('unknown');
    }, HARNESS_PROBE_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      finish('unknown');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A signal-killed probe (code null) never answered the question.
      finish(code === null ? 'unknown' : code === 0);
    });
  });
}

function sameSnapshot(a: HarnessAvailability, b: HarnessAvailability): boolean {
  return ALL_AGENT_HARNESSES.every((h) => a[h] === b[h]);
}

function publish(avail: HarnessAvailability): void {
  const changed = lastSnapshot !== null && !sameSnapshot(lastSnapshot, avail);
  lastSnapshot = avail;
  if (!changed) return;
  for (const listener of listeners) {
    try { listener(avail); } catch { /* a listener must not break detection */ }
  }
}

function clearReprobe(): void {
  if (reprobeTimer) clearTimeout(reprobeTimer);
  reprobeTimer = null;
}

function scheduleReprobe(): void {
  if (reprobeTimer || reprobeAttempt >= REPROBE_DELAYS_MS.length) return;
  const delay = REPROBE_DELAYS_MS[reprobeAttempt++]!;
  reprobeTimer = setTimeout(() => {
    reprobeTimer = null;
    detectHarnesses().catch(() => {});
  }, delay);
  reprobeTimer.unref?.();
}

export function detectHarnesses(): Promise<HarnessAvailability> {
  if (cached) return cached;
  if (inflight) return inflight;
  const gen = generation;
  const run = Promise.all(ALL_AGENT_HARNESSES.map((harness) => isOnPath(harness)))
    .then((results) => {
      const avail = Object.fromEntries(
        ALL_AGENT_HARNESSES.map((h, i) => [h, results[i] === true]),
      ) as HarnessAvailability;
      if (gen !== generation) return avail;
      inflight = null;
      if (results.every((r) => r !== 'unknown')) {
        cached = Promise.resolve(avail);
        clearReprobe();
        reprobeAttempt = 0;
      } else {
        const unknown = ALL_AGENT_HARNESSES.filter((_, i) => results[i] === 'unknown');
        console.warn(
          `[harnesses] PATH probe timed out or failed for ${unknown.join(', ')}; ` +
            'reporting unavailable for now and re-probing',
        );
        scheduleReprobe();
      }
      publish(avail);
      return avail;
    });
  inflight = run;
  return run;
}

// Called with the new snapshot whenever a (re-)probe changes availability —
// e.g. a boot-time timeout corrected by the background re-probe. Returns an
// unsubscribe function.
export function onHarnessAvailabilityChange(
  listener: (avail: HarnessAvailability) => void,
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Force a re-probe — useful if the user installs a CLI after the server is
// already running and wants the UI to pick it up without a full restart.
export function resetHarnessCache(): void {
  generation++;
  cached = null;
  inflight = null;
  clearReprobe();
  reprobeAttempt = 0;
}

// Test seam: swap the probe spawner and drop all module state.
export function __setHarnessProbeSpawnForTests(fn: SpawnFn | null): void {
  spawnImpl = fn ?? spawn;
  resetHarnessCache();
  lastSnapshot = null;
  listeners.clear();
}
