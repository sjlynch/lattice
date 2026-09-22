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
  //
  // The multiply MUST be `Math.imul` (a true 32-bit product). A plain `h *
  // FNV_PRIME` reaches ~2^56, past a double's 53-bit mantissa, so its low bits
  // were rounded away before `>>> 0` — not FNV-1a at all, and ~72% of keys came
  // out with their low 3 bits zero, raising the odds that a same-count rename
  // collides and reuses a stale depth map.
  let h = FNV_OFFSET_BASIS;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME) >>> 0;
    }
    h = Math.imul(h ^ FNV_SEPARATOR, FNV_PRIME) >>> 0;
  };
  mix(data.root);
  for (const n of data.nodes) mix(n.id);
  // Node count is folded in too as a cheap extra guard against a hash collision.
  return `${data.nodes.length}:${h >>> 0}`;
}
