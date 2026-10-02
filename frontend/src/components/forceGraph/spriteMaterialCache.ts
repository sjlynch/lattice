// Shared, module-level sprite-material caches for the graph's hand-painted
// sprites: file shapes (`sprites.ts`), agent presence/satellite discs
// (`claudeNodeSprite.ts`), worktree rings (`worktreeRing.ts`) and change rings
// (`changeRingMaterials.ts`). Each entry is built once per key and borrowed by
// every node that shares that style; never dispose an entry per node.
//
// The caches outlive any one graph: a project switch, Retry or error-boundary
// reset remounts the graph with a fresh WebGL renderer. Once a renderer has
// drawn a material or texture, three keeps a `dispose` listener on it that
// closes over that renderer's GL state, so a cached entry pins the old context
// until it is disposed. three-forcegraph already disposes whatever is attached
// to the scene on `refresh()` and `_destructor`; entries that are not (colors
// no longer in use, for example) stay pinned. So every cache made here is
// disposed AND dropped once per graph teardown by `disposeSharedGraphResources`
// (wired through `hooks/useForceGraphInitialization`); the next graph rebuilds
// entries on demand. A second dispose of an already-disposed entry finds no
// listener, so this is safe alongside the library's own disposal. Source
// canvases are never zeroed, so a late holder of a disposed entry still
// re-uploads it on next use.

import type { SpriteMaterial } from 'three';
import { disposeHaloResources } from './haloResources';

type CachedMaterial = { dispose(): void; map?: { dispose(): void } | null };

export type SpriteMaterialCache<K, M extends CachedMaterial = SpriteMaterial> = {
  // The entry for `key`, built by `create` on first use.
  get(key: K, create: () => M): M;
  // The existing entry, without building one.
  peek(key: K): M | undefined;
  // Disposes each entry and its map once, then empties the cache.
  disposeAll(): void;
};

// One `disposeAll` per cache created below: all of them are module-level and
// registered for graph teardown.
const sharedCacheDisposers: (() => void)[] = [];

export function createSpriteMaterialCache<
  K,
  M extends CachedMaterial = SpriteMaterial,
>(): SpriteMaterialCache<K, M> {
  const entries = new Map<K, M>();
  const cache: SpriteMaterialCache<K, M> = {
    get(key, create) {
      let entry = entries.get(key);
      if (!entry) {
        entry = create();
        entries.set(key, entry);
      }
      return entry;
    },
    peek: (key) => entries.get(key),
    disposeAll() {
      const disposed = [...entries.values()];
      entries.clear();
      for (const entry of disposed) {
        entry.map?.dispose();
        entry.dispose();
      }
    },
  };
  sharedCacheDisposers.push(cache.disposeAll);
  return cache;
}

// Graph-teardown release of every shared sprite cache plus the selection-halo
// singletons (whose JS objects stay; see `haloResources.ts`). Idempotent and a
// no-op on empty caches. Each cache is attempted even if another throws; the
// first error is rethrown afterwards.
export function disposeSharedGraphResources(): void {
  const errors: unknown[] = [];
  for (const dispose of [...sharedCacheDisposers, disposeHaloResources]) {
    try {
      dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors[0];
}
