import type { PiMenuEntry } from './api';

// Pure, side-effect-free core of the shared Pi-model menu cache (no `./api`
// runtime import, so it's unit-testable with a fake fetcher). The app singleton
// + `getPiModels` wiring lives in `piModelMenuStore.ts`.

export type PiMenuFetcher = () => Promise<PiMenuEntry[]>;
export type PiMenuListener = () => void;

export type PiMenuStore = {
  // Current cached menu (stable reference between loads — safe for
  // useSyncExternalStore's getSnapshot).
  getMenu: () => PiMenuEntry[];
  // Whether at least one load has populated the cache.
  isLoaded: () => boolean;
  // Fetch once, lazily: a no-op when already loaded or a load is in flight.
  ensure: () => Promise<void>;
  // Force a refetch (after a relevant settings save) and notify subscribers.
  refresh: () => Promise<void>;
  subscribe: (listener: PiMenuListener) => () => void;
};

export function createPiMenuStore(fetchMenu: PiMenuFetcher): PiMenuStore {
  let menu: PiMenuEntry[] = [];
  let loaded = false;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<PiMenuListener>();

  const emit = () => {
    // Snapshot first so a listener that unsubscribes mid-notify doesn't skip a
    // sibling.
    for (const listener of [...listeners]) listener();
  };

  const load = (): Promise<void> => {
    const p = fetchMenu()
      .then((next) => {
        menu = next;
        loaded = true;
      })
      .catch(() => {
        // Keep the prior cache on failure (getPiModels already swallows its own
        // errors into empty lists; this guards a custom fetcher too).
      })
      .finally(() => {
        if (inFlight === p) inFlight = null;
        emit();
      });
    inFlight = p;
    return p;
  };

  return {
    getMenu: () => menu,
    isLoaded: () => loaded,
    ensure: () => inFlight ?? (loaded ? Promise.resolve() : load()),
    refresh: () => load(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
