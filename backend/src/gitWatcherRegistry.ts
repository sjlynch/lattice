// Shared per-project watcher registry behind gitBranch.ts and gitStatus.ts: one
// lazily-built watcher per canonical project root, shared by every subscriber,
// with an isolated fan-out and the post-`git init` rearm path.

import { canonicalProjectPath } from './projectPath.js';

export type ProjectWatcherSlot<V> = {
  root: string;
  subscribers: Set<(value: V) => void>;
  current: V;
};

export type ProjectWatcherRegistryOptions<S extends ProjectWatcherSlot<V>, V> = {
  // Log prefix, e.g. `[git-status watcher]`.
  label: string;
  // Build the slot for a root: compute its initial value and arm its watchers.
  create(root: string): Promise<S>;
  // Attach the watchers if not attached yet (a no-op when already armed).
  arm(slot: S): Promise<void>;
  // Re-derive the current value for a root.
  compute(root: string): Promise<V>;
  // Close the slot's watchers (test reset only — slots otherwise live forever).
  close(slot: S): Promise<void>;
};

export type ProjectWatcherRegistry<V> = {
  subscribe(projectRoot: string, cb: (value: V) => void): Promise<() => void>;
  rearm(projectRoot: string): Promise<void>;
  resetForTest(): Promise<void>;
};

// Per-subscriber isolation: one throwing subscriber used to abort the loop, so
// every client after it in the set silently missed the change.
export function fanOut<V>(
  label: string,
  subscribers: Set<(value: V) => void>,
  value: V,
): void {
  for (const cb of [...subscribers]) {
    try {
      cb(value);
    } catch (err) {
      console.error(`${label} subscriber threw:`, err);
    }
  }
}

// Store `value` and wake subscribers ONLY when it actually changed, so noise
// never spams clients.
export function publishIfChanged<V>(
  label: string,
  slot: ProjectWatcherSlot<V>,
  value: V,
): void {
  if (value === slot.current) return;
  slot.current = value;
  fanOut(label, slot.subscribers, value);
}

export function createProjectWatcherRegistry<S extends ProjectWatcherSlot<V>, V>(
  opts: ProjectWatcherRegistryOptions<S, V>,
): ProjectWatcherRegistry<V> {
  // Keyed by the in-flight (or settled) creation promise so concurrent first
  // subscriptions for one root share a single watcher (mirrors
  // health/watcher.ts). Kept for the life of the process: a WS reconnect storm
  // would otherwise churn (close+recreate) the watchers on every drop, and a
  // watcher or two per opened project is cheap. Bounded by the number of
  // distinct project roots opened in a session.
  const slots = new Map<string, Promise<S>>();

  function ensure(root: string): Promise<S> {
    const existing = slots.get(root);
    if (existing) return existing;
    const creation = opts.create(root);
    slots.set(root, creation);
    // A failed build must not poison the slot forever — drop it so the next
    // subscriber retries from scratch.
    creation.catch(() => {
      if (slots.get(root) === creation) slots.delete(root);
    });
    return creation;
  }

  // Best-effort by design: no subscribers means no watcher to fix (the first
  // subscriber will build one against the new repo), and a failed build is left
  // for the next subscriber to retry.
  async function rearm(projectRoot: string): Promise<void> {
    const root = canonicalProjectPath(projectRoot);
    const pending = slots.get(root);
    if (!pending) return;
    let slot: S;
    try {
      slot = await pending;
    } catch {
      return;
    }
    await opts.arm(slot);
    publishIfChanged(opts.label, slot, await opts.compute(root));
  }

  // The current value is delivered right after the watcher resolves so a fresh
  // subscriber syncs without waiting for the next change; every subsequent
  // real change re-invokes the callback.
  async function subscribe(
    projectRoot: string,
    cb: (value: V) => void,
  ): Promise<() => void> {
    const root = canonicalProjectPath(projectRoot);
    const slot = await ensure(root);
    const alreadyRegistered = slot.subscribers.has(cb);
    slot.subscribers.add(cb);
    try {
      cb(slot.current);
    } catch (err) {
      // Roll back only this call's acquisition, keeping any earlier registration.
      if (!alreadyRegistered) slot.subscribers.delete(cb);
      throw err;
    }
    return () => {
      slot.subscribers.delete(cb);
    };
  }

  // Close every watcher and clear the map so suites don't leak persistent
  // chokidar FSWatchers across tests.
  async function resetForTest(): Promise<void> {
    const pending = [...slots.values()];
    slots.clear();
    await Promise.all(
      pending.map(async (p) => {
        try {
          await opts.close(await p);
        } catch {
          /* build failed or already closed */
        }
      }),
    );
  }

  return { subscribe, rearm, resetForTest };
}
