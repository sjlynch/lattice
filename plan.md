> **Historical design note (June 2026).** Superseded by the code and
> `frontend/src/components/forceGraph/CLAUDE.md`; details below may be stale.
> Do not treat this as current behaviour.

# Graph perf restoration plan

Local working notes for the force-graph performance fixes. Updated as
each task lands; **`[x]`** = done, **`[~]`** = in progress, **`[ ]`** =
pending.

## Root cause

The `idleController.pauseAnimation()` optimization is intact, but the
`engine` reason was being held continuously during normal dev because:

- `useProjectScan` emits a new `ScanResult` ref on every backend
  `HealthUpdate` (`updated`, `removed`, `rescan`).
- `useGraphDataSync` is keyed on the `data` ref. Every new ref called
  `graph.graphData(...)` + `idle.engineStarted()`.
- 3d-force-graph's `graphData` setter re-warms the layout, resetting
  the cooldown. We never overrode `d3AlphaMin` / `cooldownTicks`, so
  the only stop condition was the 15 s wall-clock `cooldownTime`.
- On an active dev box (vite HMR, tsc emit, AV scans) those resets
  arrived faster than 15 s → engine never settled → idle controller
  never paused the render loop.

Secondary contributors:

- Selection clicks called `graph.refresh()` which rebuilt **every**
  `nodeThreeObject` (1000+ sprites per click on a big project).
- `useGitTimeline` called `clearLabelsAndRefresh` on every scrub even
  when no rings actually flipped.
- Per-sprite `onBeforeRender` camera-scaling for label sprites is
  O(labels) per frame.
- Raycaster walks every visible sprite per pointermove.

## Tier 1 — restore idle (regression fix)

- [x] **1.1 Skip `graph.graphData(...)` when the structural shape is
  unchanged.** In `useGraphDataSync`, hash sorted node-ids + sorted
  `source|target` link keys. When the new hash matches the previous
  push: patch per-node fields (`health`, `healthDetails`, `loc`,
  `size`) on the in-place sim data and call `graph.refresh()` only —
  do not call `engineStarted()` or `graph.graphData(...)`.
  *(`frontend/src/components/forceGraph/hooks/useGraphDataSync.ts`.)*
- [x] **1.2 Stop double-updating on `removed` events.** In
  `useProjectScan`, `removed` events still patch locally but the
  follow-up rescan is now debounced at `REMOVED_RESCAN_DEBOUNCE_MS =
  1500` so a burst of deletes shares one rescan.
  *(`frontend/src/hooks/useProjectScan.ts`.)*
- [x] **1.3 Hard-cap the d3 engine.** In `useForceGraphInitialization`:
  `.cooldownTicks(400)`, `.cooldownTime(8000)`, `.d3AlphaMin(0.005)`.
  The engine now reliably settles in 2–4 s of motion after a real
  shape change, regardless of wall-clock interruptions.
  *(`frontend/src/components/forceGraph/hooks/useForceGraphInitialization.ts`.)*
- [x] **1.4 Belt-and-braces engine-reason auto-release.** In
  `idleController.engineStarted`, a 20 s safety timer auto-releases
  the engine reason if `onEngineStop` doesn't fire. Re-armed on every
  `engineStarted` (covers consecutive `graphData()` swaps or explicit
  reheats). Cleared in `destroy`.
  *(`frontend/src/components/forceGraph/idleController.ts`.)*

## Tier 2 — make refresh() cheap

- [x] **2.1 Selection halo updates without `graph.refresh()`.**
  - `buildNodeObject` now always returns a `THREE.Group` "root" so
    every node has a stable container for sibling children.
  - `halo.ts` replaced `withHalo` (wrapper) with `setNodeHalo(root,
    on, baseSize)` (idempotent sibling add/remove, tagged via
    `userData['lattice:halo']`).
  - New `selectionHaloSync.ts` looks up each affected sim node via
    three-forcegraph's `__threeObj` binding and applies the delta.
  - `ForceGraphView` selection effect now calls
    `applySelectionHaloDelta(graph, prev, next, settings)` +
    `wakeForRefresh()` — never `clearLabelsAndRefresh`.
  - Selection click cost dropped from O(nodes) sprite allocations to
    O(delta) child add/remove.
- [~] **2.2 Same treatment for `metricsIgnoredExtsSet` change.**
  *Punted.* Settings-driven, low frequency. Existing full
  `clearLabelsAndRefresh` is fine; revisit only if profile shows it.
- [x] **2.3 Skip `clearLabelsAndRefresh` on timeline range changes
  when no rings flipped.** `useGitTimeline` now compares the prev and
  next change map with `changeMapsEqual` and skips the refresh when
  every (path, kind) entry matches. Eliminates per-pixel sprite
  rebuilds during a slider drag.
  *(`frontend/src/components/forceGraph/hooks/useGitTimeline.ts`.)*

## Tier 3 — frame cost at scale (deferred pending profile)

- [ ] **3.1 Cache the per-sprite camera distance** so `onBeforeRender`
  skips work when the camera hasn't moved.
- [ ] **3.2 Cap raycaster cost.** `firstHitOnly = true`, ensure halos
  + connectors are non-raycastable, optionally throttle hover sample
  rate above N nodes.
- [ ] **3.3 `THREE.Points` atlas for base node view.** Big refactor.
- [ ] **3.4 Cap overlay labels by frustum / top-N.**

These should only be worth doing if a perf trace after Tier 1+2 still
shows dropped frames at 1000+ nodes.

## Tier 4 — cleanups

- [x] **4.1 Document the structural bound on `materialCache`.**
  Comment added in `sprites.ts` explaining it caps at ~40 entries by
  construction.
- [x] **4.2 `enablePointerInteraction(false)→(true)` flap.** Kept
  inside `clearLabelsAndRefresh` (still used after overlay toggles
  where the hover target needs invalidation). The selection path now
  bypasses `clearLabelsAndRefresh` entirely via Tier 2.1, so the flap
  no longer fires per click.
- [ ] **4.3 Verify with a perf trace.** Manual: load a 1000-file
  project with the dev server running. Expectations:
  - Idle tab with file watcher events landing in the background: 0
    RAF ticks (devtools Performance tab shows `pauseAnimation` engaged).
  - 20 selection clicks: <5 ms commit per click (down from 50–200 ms
    on big projects).
  - Timeline scrubber drag: no sprite-rebuild storm; only the ticks
    that flip ring kinds should fire `clearLabelsAndRefresh`.

## Files touched

- `frontend/src/components/forceGraph/hooks/useGraphDataSync.ts` (1.1)
- `frontend/src/hooks/useProjectScan.ts` (1.2)
- `frontend/src/components/forceGraph/hooks/useForceGraphInitialization.ts` (1.3)
- `frontend/src/components/forceGraph/idleController.ts` (1.4)
- `frontend/src/components/forceGraph/halo.ts` (2.1)
- `frontend/src/components/forceGraph/nodeObjectFactory.ts` (2.1)
- `frontend/src/components/forceGraph/selectionHaloSync.ts` (2.1, new)
- `frontend/src/components/forceGraph/ForceGraphView.tsx` (2.1)
- `frontend/src/components/forceGraph/hooks/useGitTimeline.ts` (2.3)
- `frontend/src/components/forceGraph/sprites.ts` (4.1)
- `frontend/src/components/forceGraph/CLAUDE.md` (docs sync)

## Verification

- `frontend`: `npx tsc -b` ✅
- `frontend`: `npm test` → 52/52 pass ✅
- `backend`: `npx tsc --noEmit` ✅ (untouched, sanity check)
- Manual perf trace (4.3): user to run after reload.
