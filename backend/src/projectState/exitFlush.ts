export type PendingPersistFlushable = { flushPendingPersistsSync(): void };
export type ProjectStateFlushable = { flushAllPendingPersists(): Promise<void> };

// Stores holding state mutated since its last completed write — a debounced
// persist that has not fired yet, OR one whose timer fired and whose async
// write is still in flight (lock wait, stringify, a Windows rename retry). A
// natural exit waits for those, but `process.exit()` does not: the health
// watcher's SIGINT/SIGTERM handler, the fatal-error guard and a restart all
// exit explicitly, and each used to drop up to `persistDelayMs` of task
// mutations (a just-created task, a status flip) with the timer — or, once the
// timer had fired, with the unfinished write.
const storesWithPendingPersist = new Set<PendingPersistFlushable>();
let exitFlushInstalled = false;

function ensureExitFlushHook(): void {
  if (exitFlushInstalled) return;
  exitFlushInstalled = true;
  process.once('exit', () => {
    for (const store of [...storesWithPendingPersist]) store.flushPendingPersistsSync();
  });
}

// A `flushOnExit` store just marked a key dirty: install the once-only `exit`
// hook (first time only), then track the store until its pending persists are
// written.
export function trackPendingPersist(store: PendingPersistFlushable): void {
  ensureExitFlushHook();
  storesWithPendingPersist.add(store);
}

export function untrackPendingPersist(store: PendingPersistFlushable): void {
  storesWithPendingPersist.delete(store);
}

// Every store instance (weakly held — tests construct many). Backs
// `flushAllProjectStatePersists`, which the restart drain calls right before
// the dev runner kills this process: on Windows that kill is TerminateProcess,
// so neither the `exit` hook above nor a signal handler ever runs, and a
// debounced write still inside its timer (a task status flip, a merge-run
// record) would simply be lost.
const allStores = new Set<WeakRef<ProjectStateFlushable>>();

export function registerProjectStateStore(store: ProjectStateFlushable): void {
  allStores.add(new WeakRef(store));
}

export async function flushAllProjectStatePersists(): Promise<void> {
  const flushes: Promise<void>[] = [];
  for (const ref of [...allStores]) {
    const store = ref.deref();
    if (!store) {
      allStores.delete(ref);
      continue;
    }
    flushes.push(store.flushAllPendingPersists());
  }
  await Promise.all(flushes);
}
