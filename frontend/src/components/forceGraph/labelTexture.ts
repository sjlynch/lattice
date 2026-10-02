import type * as THREE from 'three';
import { drawMeasuredLabelTexture } from './measuredLabelTexture';
import type { SpriteUvBounds } from './spritePicking';
import { disposeLabelMaterial } from './labelSpriteResources';

// Cache ownership lives here: keying, references, eviction and disposal.
// Measurement and rasterization live in measuredLabelTexture.ts; drawing must
// finish before a miss evicts or inserts any cache entries.

export type MeasuredLabelTexture = THREE.CanvasTexture & {
  _aspect?: number;
  _hitBounds?: SpriteUvBounds;
};

// Byte budget for the FREE entries of a cache that opts in through
// `LabelTextureOptions.maxFreeBytes` (the Alt name-label and metric-label
// caches do). A free entry keeps its canvas pixels (width × height × 4) and,
// until something disposes the texture, the same again on the GPU. The entry
// cap alone let 256 free name labels (bold 56px text on 96px-tall canvases,
// ~100–400 KB each) hold tens of MB that no sprite was drawing.
export const LABEL_TEXTURE_FREE_BYTES_BUDGET = 8 * 1024 * 1024;

// A bounded cache of measured label textures. Eviction is **refcount-aware**: a
// texture currently bound to a mounted sprite (refcount > 0) is NEVER evicted
// or disposed. Disposing a still-mounted texture's GPU handle out from under a
// sprite that keeps drawing it was the source of the per-frame texture thrash +
// transient blank/black labels bug (three.js re-uploads the retained canvas
// every render). Only entries no live sprite references are reclaimed, and
// reclaiming one disposes BOTH the texture and its paired (shared-by-texture)
// SpriteMaterial. Both caps (entries, free bytes) bound the FREE set only; an
// in-use entry never counts against either and is never touched by either.
export type LabelTextureCache = {
  // key → texture, kept in insertion order so eviction prefers the oldest
  // *free* entry (an approximate LRU over the unused set).
  byKey: Map<string, MeasuredLabelTexture>;
  // key → number of live sprites referencing the texture. A missing key is 0.
  // Incremented on every build (hit or miss = one new sprite about to use it),
  // decremented by releaseLabelTexture when a sprite is torn down.
  refs: Map<string, number>;
  // texture → its key, so a release given only the texture can find its slot.
  keyOf: WeakMap<MeasuredLabelTexture, string>;
  // Keys whose refcount is 0 (evictable), in the order they became free, so
  // eviction is O(1) instead of a scan over every in-use entry — which made
  // building N labels O(N²) once the cache had grown past its cap.
  free: Set<string>;
  // key → bytes of its canvas (width × height × 4), recorded when drawn.
  // Eviction zeroes the canvas, so the size can't be re-read afterwards.
  bytes: Map<string, number>;
  // Sum of `bytes` over the `free` set, checked against `maxFreeBytes`.
  freeBytes: number;
  // Remember the owner's caps so teardown can reclaim an over-cap burst even
  // if the overlay stays off and no subsequent build happens.
  maxEntries: number;
  maxFreeBytes: number;
  // True between `deferLabelTextureTrim` and the owner's `trimLabelTextureCache`
  // (a batched release, see those functions): releases and misses don't evict.
  trimDeferred: boolean;
};

export type LabelTextureOptions = {
  font: string;
  strokeWidth: number;
  height: number;
  padX: number;
  minWidth: number;
  maxEntries: number;
  // Cap on the bytes held by free entries (normally
  // LABEL_TEXTURE_FREE_BYTES_BUDGET). Omitted = only `maxEntries` applies.
  maxFreeBytes?: number;
  strokeStyle?: string;
  minV?: number;
  maxV?: number;
};

// How a blanket registry clear (the overlay modules' `clear*LabelRegistry`)
// reclaims the textures it releases:
// - 'immediate': every last-reference release trims the cache to its caps at
//   once, exactly like a single-sprite release.
// - 'batched': a rebuild follows that re-acquires most of the labels. Release
//   without evicting (`deferLabelTextureTrim`); unless the batch left nothing
//   free (`settleLabelTextureBatch`), the caller runs one
//   `trimLabelTextureCache` after the rebuild.
// - 'teardown': nothing rebuilds these labels. Release, then evict every free
//   entry (`trimLabelTextureCache(cache, 0)`).
export type LabelRegistryRelease = 'immediate' | 'batched' | 'teardown';

export function createLabelTextureCache(): LabelTextureCache {
  return {
    byKey: new Map<string, MeasuredLabelTexture>(),
    refs: new Map<string, number>(),
    keyOf: new WeakMap<MeasuredLabelTexture, string>(),
    free: new Set<string>(),
    bytes: new Map<string, number>(),
    freeBytes: 0,
    maxEntries: Infinity,
    maxFreeBytes: Infinity,
    trimDeferred: false,
  };
}

function disposeMeasuredLabelTexture(tex: MeasuredLabelTexture): void {
  disposeLabelMaterial(tex);
  tex.dispose();
  // THREE.dispose releases GPU storage, but the owned canvas still holds its
  // native pixel buffer until GC. Tiny JS wrappers can leave gigabytes of
  // discarded pixels waiting for collection during label churn. Reset only
  // on eviction/owner teardown; cached or still-mounted labels need the image.
  tex.image.width = 0;
  tex.image.height = 0;
}

// Evict the OLDEST free (refcount 0) entries until the cache is at maxEntries
// and its free entries fit `cache.maxFreeBytes`, or nothing free is left.
// Builds reserve one slot; single releases trim to the caps immediately,
// without waiting for another cache miss. In-use entries are never touched, so
// a mounted texture is never disposed; if every entry is in use the cache grows
// past maxEntries until labels are released — correctness beats the soft cap.
// Evicting down to the cap (not just one slot) matters after such a burst: a
// 2,000-label Alt band left 2,000 canvases + GPU textures cached for the rest
// of the session when each later miss only swapped one out. Evicting frees the
// texture AND its paired material together (the material is keyed by, and only
// useful with, that one texture).
function evictFreeEntries(cache: LabelTextureCache, maxEntries: number): void {
  for (const key of cache.free) {
    if (cache.byKey.size <= maxEntries && cache.freeBytes <= cache.maxFreeBytes) return;
    cache.free.delete(key);
    cache.freeBytes -= cache.bytes.get(key) ?? 0;
    cache.bytes.delete(key);
    const tex = cache.byKey.get(key);
    cache.byKey.delete(key);
    cache.refs.delete(key);
    if (!tex) continue;
    cache.keyOf.delete(tex);
    disposeMeasuredLabelTexture(tex);
  }
}

export function buildMeasuredLabelTexture(
  cache: LabelTextureCache,
  text: string,
  color: string,
  options: LabelTextureOptions,
): MeasuredLabelTexture {
  cache.maxEntries = options.maxEntries;
  cache.maxFreeBytes = options.maxFreeBytes ?? Infinity;
  const key = `${text}|${color}`;
  const cached = cache.byKey.get(key);
  if (cached) {
    // Another sprite is about to reference this texture — count it as in-use so
    // a concurrent eviction can't dispose it from under that sprite.
    cache.refs.set(key, (cache.refs.get(key) ?? 0) + 1);
    if (cache.free.delete(key)) cache.freeBytes -= cache.bytes.get(key) ?? 0;
    return cached;
  }

  const tex = drawMeasuredLabelTexture(text, color, options);
  // Inside a batched release this miss belongs to the rebuild that is
  // re-acquiring the entries just freed; evicting the oldest free entry now
  // could drop one a later node of the same rebuild is about to hit. The
  // owner's deferred trim restores the caps once the rebuild is done.
  if (!cache.trimDeferred) evictFreeEntries(cache, options.maxEntries - 1);
  cache.byKey.set(key, tex);
  cache.keyOf.set(tex, key);
  cache.refs.set(key, 1);
  cache.bytes.set(key, tex.image.width * tex.image.height * 4);
  return tex;
}

// Drop one live-sprite reference to a cached label texture. Call this when a
// sprite built from `buildMeasuredLabelTexture` is removed from the scene, so
// the texture becomes evictable once nothing draws it. Safe to call with a
// null/undefined map or a texture already evicted (no-op). Outside a batched
// release the last reference trims the cache to its caps immediately (the
// per-entry paths: Alt label toggles, the repulsion loop's `onDetached`).
export function releaseLabelTexture(
  cache: LabelTextureCache,
  texture: THREE.Texture | null | undefined,
): void {
  if (!texture) return;
  const key = cache.keyOf.get(texture as MeasuredLabelTexture);
  if (key === undefined) return;
  const n = cache.refs.get(key) ?? 0;
  if (n <= 1) {
    cache.refs.delete(key);
    if (!cache.free.has(key)) {
      cache.free.add(key);
      cache.freeBytes += cache.bytes.get(key) ?? 0;
    }
    if (!cache.trimDeferred) evictFreeEntries(cache, cache.maxEntries);
  } else {
    cache.refs.set(key, n - 1);
  }
}

// Start a batched release: until the owner's next `trimLabelTextureCache`,
// releases only move entries to `free` (oldest first, as always) and misses
// only insert. For a blanket clear that a rebuild immediately follows
// (`graph.refresh()` / `graph.graphData()`): trimming per release disposed every
// still-on-screen label past the cap, and the rebuild then redrew each one as a
// brand-new canvas. Deferring lets the rebuild re-acquire them from `free`
// instead. After releasing, the caller asks `settleLabelTextureBatch` whether it
// owes the cache that one trim (hooks/refresh.ts schedules it).
export function deferLabelTextureTrim(cache: LabelTextureCache): void {
  cache.trimDeferred = true;
}

// Call after a batched release. A batch that left no free entry has nothing to
// protect or trim, so it ends here. Returns true when the cache now waits for
// the caller's deferred `trimLabelTextureCache`.
export function settleLabelTextureBatch(cache: LabelTextureCache): boolean {
  if (cache.free.size === 0) cache.trimDeferred = false;
  return cache.trimDeferred;
}

// End any batched release and evict the oldest free entries until the cache is
// within `maxEntries` (default: the owner's cap) and its free-bytes budget.
// `maxEntries = 0` reclaims every free entry (owner teardown: the overlay
// caches are module-level and outlive the graph). In-use entries are never
// evicted, whatever the caps.
export function trimLabelTextureCache(
  cache: LabelTextureCache,
  maxEntries: number = cache.maxEntries,
): void {
  cache.trimDeferred = false;
  evictFreeEntries(cache, maxEntries);
}

// Dispose every texture (and its paired material) in the cache and empty it.
// Used when the cache's owner is torn down entirely (e.g. the agent overlay on
// destroy), where the whole label set is going away at once.
export function disposeLabelTextureCache(cache: LabelTextureCache): void {
  for (const tex of cache.byKey.values()) {
    disposeMeasuredLabelTexture(tex);
  }
  cache.byKey.clear();
  cache.refs.clear();
  cache.free.clear();
  cache.bytes.clear();
  cache.freeBytes = 0;
  cache.trimDeferred = false;
  // A late release of an old texture must not touch a rebuilt entry's refs.
  cache.keyOf = new WeakMap<MeasuredLabelTexture, string>();
}
