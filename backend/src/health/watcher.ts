// Facade for the per-project health file watcher. Owns only the singleton
// memoization (the watchers map + ensureWatcher) and the shutdown-flush
// lifecycle hooks; the actual per-root construction and chokidar/event wiring
// lives in ./watcher/setup.ts. One watcher per project root; multiple WS
// subscribers can share the same watcher.

import { canonicalProjectPath } from '../projectPath.js';
import { createWatcher } from './watcher/setup.js';
import { disposeIsolatedAnalyzer } from './watcher/isolatedAnalyze.js';
import { WatcherRevision } from './watcher/revision.js';
import { ScanPublication, type WatcherSlot } from './watcher/scanPublication.js';
import type {
  HealthUpdate,
  ProjectWatcher,
  Subscriber,
} from './watcher/types.js';

export type { HealthUpdate };

// Each slot stores its creation promise and synchronously-available revision.
// Concurrent first subscriptions share one build; scans can capture its event
// revision even before construction has completed.
const watchers = new Map<string, WatcherSlot>();
const scanPublication = new ScanPublication((root) => watchers.get(root));

function ensureWatcher(projectRoot: string): Promise<ProjectWatcher> {
  const existing = watchers.get(projectRoot);
  if (existing) return existing.creation;

  // Insert the promise BEFORE the first await in createWatcher so a second
  // caller in the same tick (two WS connects at boot, a reconnect storm, HMR)
  // sees it and shares this build.
  const revision = new WatcherRevision();
  const creation = createWatcher(projectRoot, ensureShutdownFlushHook, revision);
  const slot = { creation, revision };
  watchers.set(projectRoot, slot);
  // A failed build must not poison the slot forever — drop it so the next
  // subscriber retries from scratch (mirrors deadCode.ts's memo eviction).
  creation.catch(() => {
    if (watchers.get(projectRoot) === slot) watchers.delete(projectRoot);
  });
  return creation;
}

// Force every project's debounced health-cache write out — used on shutdown
// so a coalesced write that hasn't fired yet isn't lost. Never rejects
// (HealthCache.flush swallows write errors).
export async function flushWatcherCaches(): Promise<void> {
  // Resolve each creation promise before flushing its cache.
  const projs = await Promise.all(
    [...watchers.values()].map((slot) => slot.creation.catch(() => null)),
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

// Capture before the scan's first await, including the no-watcher case. A
// watcher created while analysis runs must not receive an older snapshot.
export function beginWatcherScan(projectRoot: string, isCancelled?: () => boolean) {
  return scanPublication.begin(canonicalProjectPath(projectRoot), isCancelled);
}

// Both receipt and publication of a file event invalidate older shared scans.
export function watcherScanRevision(projectRoot: string): number | undefined {
  return watchers.get(canonicalProjectPath(projectRoot))?.revision.current;
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
    pending.map(async (slot) => {
      try {
        const proj = await slot.creation;
        await proj.watcher.close();
      } catch { /* build failed or already closed */ }
    }),
  );
}
