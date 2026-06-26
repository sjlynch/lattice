import type { ScanResult } from '../../api';

// FNV-1a (32-bit) hash constants for `depthMapStructuralKey` below: the standard
// offset basis (seed) and prime. `FNV_SEPARATOR` is the delimiter byte mixed in
// between hashed entries so e.g. ['ab','c'] and ['a','bc'] can't collide; its
// value (0x2f, '/') is arbitrary — only that it's a consistent separator matters.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const FNV_SEPARATOR = 0x2f;

// Cheap structural fingerprint of the inputs the Alt-label depth map depends on:
// the scan root plus the node-id set (a metric-only health/LOC update keeps both
// identical — only per-node `health`/`loc` fields change). A new `data` ref whose
// fingerprint is unchanged reuses the cached depth map instead of re-walking
// every path with `depthFor`. Node id === path for real nodes, so any add /
// remove / rename — the only things that move a depth — shifts the count or an
// id and so the key.
export function depthMapStructuralKey(data: ScanResult): string {
  // FNV-1a rolling hash over the root then every node id, with a separator byte
  // mixed in between entries (so ['ab','c'] and ['a','bc'] can't collide). No
  // substring allocation, no Map build — unlike the depth recompute it guards.
  let h = FNV_OFFSET_BASIS;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h = (h ^ s.charCodeAt(i)) >>> 0;
      h = (h * FNV_PRIME) >>> 0;
    }
    h = ((h ^ FNV_SEPARATOR) * FNV_PRIME) >>> 0;
  };
  mix(data.root);
  for (const n of data.nodes) mix(n.id);
  // Node count is folded in too as a cheap extra guard against a hash collision.
  return `${data.nodes.length}:${h >>> 0}`;
}
