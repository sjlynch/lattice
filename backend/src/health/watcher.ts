// Facade for the per-project health file watcher. Owns only the singleton
// memoization (the watchers map + ensureWatcher) and the shutdown-flush
// lifecycle hooks; the actual per-root construction and chokidar/event wiring
// lives in ./watcher/setup.ts. One watcher per project root; multiple WS
// subscribers can share the same watcher.

import type { HealthMetrics } from './types.js';
import { canonicalProjectPath } from '../projectPath.js';
import { createWatcher } from './watcher/setup.js';
import { disposeIsolatedAnalyzer } from './watcher/isolatedAnalyze.js';
import type {
  HealthUpdate,
  ProjectWatcher,
  Subscriber,
} from './watcher/types.js';

export type { HealthUpdate };

// Keyed by the in-flight (or settled) CREATION PROMISE, not the resolved
// ProjectWatcher. ensureWatcher memoizes the promise synchronously — before any
// await — so concurrent first-subscriptions for one root all await the SAME
// build instead of each constructing a full ProjectWatcher (two chokidar
// watchers + two HealthCache writers, the second silently orphaning the first).
// Same in-flight-promise memo as deadCode.ts.
const watchers = new Map<string, Promise<ProjectWatcher>>();

function ensureWatcher(projectRoot: string): Promise<ProjectWatcher> {
  const existing = watchers.get(projectRoot);
  if (existing) return existing;

  // Insert the promise BEFORE the first await in createWatcher so a second
  // caller in the same tick (two WS connects at boot, a reconnect storm, HMR)
  // sees it and shares this build.
  const creation = createWatcher(projectRoot, ensureShutdownFlushHook);
  watchers.set(projectRoot, creation);
  // A failed build must not poison the slot forever — drop it so the next
  // subscriber retries from scratch (mirrors deadCode.ts's memo eviction).
  creation.catch(() => {
    if (watchers.get(projectRoot) === creation) watchers.delete(projectRoot);
  });
  return creation;
}

// Force every project's debounced health-cache write out — used on shutdown
// so a coalesced write that hasn't fired yet isn't lost. Never rejects
// (HealthCache.flush swallows write errors).
export async function flushWatcherCaches(): Promise<void> {
  // Values are creation promises now; resolve each (swallowing a failed build)
  // before flushing its cache.
  const projs = await Promise.all(
    [...watchers.values()].map((p) => p.catch(() => null)),
  );
  await Promise.all(projs.map((proj) => proj?.cache.flush()));
}

let shutdownFlushRegistered = false;

// Register process-exit handlers (once) that flush pending health-cache writes
// before the process goes away. Signal handlers must re-exit themselves —
// adding a listener suppresses Node's default terminate — and are time-boxed
// so a stuck disk can't hang a dev-server restart. On Windows a force-kill
// (TerminateProcess, e.g. the dev runner's restart) bypasses these entirely;
// that's acceptable since the cache is best-effort and re-derived from each
// file's (mtime,size) on the next scan. `beforeExit` covers a natural
// event-loop drain (no signal) and must not call process.exit itself.
function ensureShutdownFlushHook(): void {
  if (shutdownFlushRegistered) return;
  shutdownFlushRegistered = true;

  const flushThenExit = () => {
    // Release the warm analysis worker thread; it's unref()'d so it never blocks
    // exit, but disposing it promptly on a graceful signal is tidier.
    disposeIsolatedAnalyzer();
    void Promise.race([
      flushWatcherCaches(),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]).finally(() => process.exit(0));
  };
  process.once('SIGINT', flushThenExit);
  process.once('SIGTERM', flushThenExit);
  process.once('beforeExit', () => { void flushWatcherCaches(); });
}

// Subscribe to live health updates for a project. The watcher is lazily started
// on first subscription and kept running for the life of the process;
// subsequent subscribers share it.
export async function subscribeHealth(
  projectRoot: string,
  cb: Subscriber,
): Promise<() => void> {
  const proj = await ensureWatcher(canonicalProjectPath(projectRoot));
  proj.subscribers.add(cb);
  return () => proj.subscribers.delete(cb);
}

// Allow the scanner to seed the watcher's in-memory mirror after a full scan.
// Saves the watcher from running redundant cross-file passes when WebSocket
// subscribers connect.
export function seedWatcherState(
  projectRoot: string,
  importsByFile: Map<string, string[]>,
  metricsByFile: Map<string, HealthMetrics>,
): void {
  const abs = canonicalProjectPath(projectRoot);
  const pending = watchers.get(abs);
  if (!pending) return;
  // The map holds the creation promise; seed once it resolves (the caller's
  // maps aren't mutated after this call, so deferring is safe). A watcher still
  // building gets seeded as soon as it's ready instead of being missed.
  void pending
    .then((proj) => {
      proj.imports.clear();
      proj.metrics.clear();
      for (const [k, v] of importsByFile) proj.imports.set(k, v);
      for (const [k, v] of metricsByFile) proj.metrics.set(k, v);
      // The seeded membership can differ from what the memoized root set was
      // built on (a rescan, file-tree change, or cache-version bump), so drop it.
      proj.crossFile.invalidateRoots();
    })
    .catch(() => { /* watcher build failed; nothing to seed */ });
}

// Test-only: number of project watchers currently tracked (incl. in-flight
// builds). Lets the de-dup regression test assert exactly one watcher exists
// after concurrent first-subscriptions.
export function _watcherCountForTest(): number {
  return watchers.size;
}

// Test-only: close every watcher and clear the map so suites don't leak
// persistent chokidar FSWatchers (which would keep the event loop alive)
// across tests.
export async function _resetWatchersForTest(): Promise<void> {
  const pending = [...watchers.values()];
  watchers.clear();
  await Promise.all(
    pending.map(async (p) => {
      try {
        const proj = await p;
        await proj.watcher.close();
      } catch { /* build failed or already closed */ }
    }),
  );
}
