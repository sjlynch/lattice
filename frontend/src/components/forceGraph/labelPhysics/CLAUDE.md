# forceGraph/labelPhysics

The floating-label repulsion physics, split by concern. Shared by all three
label overlays (LOC `Z`, health `H`, Alt names) — each owns a registry (a
`Set<{label, line}>`) and they differ only in the minimum separation. Reached
through the parent facade `../labelRepulsion.ts` (a thin re-export), driven
per-frame by `../labelRepulsionFrames.ts` (scene frame driver + the idle
controller's `labelPhysics` reason). Nothing here touches React, the graph
instance, or the idle controller — it's pure geometry/state.

## Model

Each label is a sprite hovering over its node with a connector line down to it.
Two forces, in the node's local XZ plane: a gentle **home spring** pulling the
label back to its anchor (`HOME_K`) and **pairwise repulsion** pushing
overlapping labels apart (`PUSH_K`, tapering to zero at the requested
separation). Velocity is integrated with per-frame friction (`FRICTION`) and
snaps to rest once force + speed stay under threshold for `REST_FRAMES`.

## Per-frame tick (`repelLabels(registry, minDist)`)

1. `cleanupStaleRegistryEntries` — drop entries whose sprite was unparented.
2. `ensureCapacity(count)`, then snapshot each label's world XZ + collect
   entries into the shared scratch buffers in one pass.
3. Seed `fx`/`fz` with the home-spring force (overwrites, so no separate zero).
4. `buildSpatialGridFromScratch` + `pairwiseGrid` accumulate repulsion.
5. Per label: `integrateLabelState` (friction/rest), apply velocity to the
   sprite, `updateConnectorEndpoint` re-anchors the connector's upper end.
6. Returns `true` when every label is at rest (so the driver can release the
   idle reason and let the loop pause).

## Modules

- `types.ts` — shared shapes: `RepulsionEntry` (`{label, line}`), `LabelState`
  (`{vx, vz, restFrames}`), `WorldXZ`. In their own module to avoid cycles.
- `physics.ts` — every tuning constant (the only knobs): `HOME_K`, `PUSH_K`,
  `FRICTION`, rest thresholds (`REST_VEL`/`REST_FORCE` + pre-squared `*_SQ`
  variants that let the hot loop skip `Math.hypot`), `REST_FRAMES`, and the
  zero-distance jitter epsilons.
- `integration.ts` — per-label velocity/rest integration, connector
  re-anchoring, and the `stateMap` WeakMap (velocity keyed on the sprite, so a
  dropped registry entry GCs its state automatically). `integrateLabelState`
  uses squared magnitudes to avoid two `hypot`s per label per frame.
- `repel.ts` — the per-frame `repelLabels` entry point (the tick above), tying
  scratch buffers + grid + integration together.
- `spatialGrid.ts` — uniform grid (cell = `minDist`) + pairwise phase: each
  label only checks its 3×3 neighbourhood (O(N·k), not O(N²)). Cells are keyed
  by a packed **integer** `(cx + BIAS) * STRIDE + (cz + BIAS)` so the hot loop
  allocates no per-cell key strings (collision-free for any real graph; see the
  render-path perf invariant in the parent `CLAUDE.md`). The build pass stashes
  each label's integer `(cx, cz)` into `cellX`/`cellZ` for the pairwise pass to
  reuse. `accumulatePairwiseForces` is a legacy entry kept for the tests.
- `scratchBuffers.ts` — module-level reused typed arrays (`worldX`/`worldZ`/
  `fx`/`fz`/`cellX`/`cellZ`), the `entries`/`tmpVec` temporaries, the integer-
  keyed `cellGrid` Map + its recycled `bucketPool`. `ensureCapacity(n)` grows
  them all in lockstep; the typed arrays are live `let` exports, so consumers
  must read them fresh after `ensureCapacity` rather than caching the reference.

## Tests

`src/__tests__/labelRepulsion.test.ts` asserts on force/integration results
(not key form), so the integer-key and scratch-buffer changes stay green.
