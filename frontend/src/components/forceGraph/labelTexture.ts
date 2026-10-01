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

// A bounded cache of measured label textures. Eviction is **refcount-aware**: a
// texture currently bound to a mounted sprite (refcount > 0) is NEVER evicted
// or disposed. Disposing a still-mounted texture's GPU handle out from under a
// sprite that keeps drawing it was the source of the per-frame texture thrash +
// transient blank/black labels bug (three.js re-uploads the retained canvas
// every render). Only entries no live sprite references are reclaimed, and
// reclaiming one disposes BOTH the texture and its paired (shared-by-texture)
// SpriteMaterial.
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
  // Remember the owner's cap so teardown can reclaim an over-cap burst even
  // if the overlay stays off and no subsequent build happens.
  maxEntries: number;
};

export type LabelTextureOptions = {
  font: string;
  strokeWidth: number;
  height: number;
  padX: number;
  minWidth: number;
  maxEntries: number;
  strokeStyle?: string;
  minV?: number;
  maxV?: number;
};

export function createLabelTextureCache(): LabelTextureCache {
  return {
    byKey: new Map<string, MeasuredLabelTexture>(),
    refs: new Map<string, number>(),
    keyOf: new WeakMap<MeasuredLabelTexture, string>(),
    free: new Set<string>(),
    maxEntries: Infinity,
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
// or nothing free is left. Builds reserve one slot; releases trim to the cap
// immediately, without waiting for another cache miss. In-use entries are
// never touched, so a mounted texture is never disposed; if every entry is in
// use the cache grows past maxEntries until labels are released — correctness
// beats the soft cap. Evicting down to the cap (not just one slot) matters after
// such a burst: a 2,000-label Alt band left 2,000 canvases + GPU textures cached
// for the rest of the session when each later miss only swapped one out.
// Evicting frees the texture AND its paired material together (the material is
// keyed by, and only useful with, that one texture).
function evictFreeEntries(cache: LabelTextureCache, maxEntries: number): void {
  for (const key of cache.free) {
    if (cache.byKey.size <= maxEntries) return;
    cache.free.delete(key);
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
  const key = `${text}|${color}`;
  const cached = cache.byKey.get(key);
  if (cached) {
    // Another sprite is about to reference this texture — count it as in-use so
    // a concurrent eviction can't dispose it from under that sprite.
    cache.refs.set(key, (cache.refs.get(key) ?? 0) + 1);
    cache.free.delete(key);
    return cached;
  }

  const tex = drawMeasuredLabelTexture(text, color, options);
  evictFreeEntries(cache, options.maxEntries - 1);
  cache.byKey.set(key, tex);
  cache.keyOf.set(tex, key);
  cache.refs.set(key, 1);
  return tex;
}

// Drop one live-sprite reference to a cached label texture. Call this when a
// sprite built from `buildMeasuredLabelTexture` is removed from the scene, so
// the texture becomes evictable once nothing draws it. Safe to call with a
// null/undefined map or a texture already evicted (no-op).
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
    cache.free.add(key);
    evictFreeEntries(cache, cache.maxEntries);
  } else {
    cache.refs.set(key, n - 1);
  }
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
  // A late release of an old texture must not touch a rebuilt entry's refs.
  cache.keyOf = new WeakMap<MeasuredLabelTexture, string>();
}
