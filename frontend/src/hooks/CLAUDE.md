# frontend/src/hooks

App-wide React hooks. The load-bearing ones own the **scan + metric-update
pipeline** that feeds the graph; the rest are small persisted-toggle /
per-project-settings helpers. The graph-specific overlay hooks live next to the
graph in `components/forceGraph/hooks/`, not here.

## Scan pipeline (data flow)

```
backend scan + health WS
  → useProjectScan        (owns the scan + the streaming metric-update queue)
      → patchUpdatedFiles  (scanResultPatch.ts: in-place metric patch)
      → a fresh ScanResult ref per save  (live `data` for metric consumers)
  → useStructuralScan      (splits a structure-only ref off the metric churn)
      → graph / legend / search / stack-detection consumers
```

- `useProjectScan(activeFolder)` — the single owner of `scanResult`. Runs the
  initial `scanFolder` (with backoff retry while the backend is still booting;
  `loading` reflects only that initial scan, never background rescans) and then
  subscribes to the backend health WS. Live events split two ways:
  - **`updated`** (metric-only, one per file save while the dev server churns) —
    coalesced into a path-keyed `metricQueue` (latest metrics win) and flushed
    on a short `METRIC_BATCH_MS` timer via `patchUpdatedFiles`, minting a fresh
    `ScanResult` ref. A queued path missing from the current scan falls back to a
    structural rescan.
  - **`rescan` / `removed`** (structural) — flush the metric queue first (those
    patches reference the pre-structural tree), then `removed` prunes the file
    locally for instant feedback and schedules a long-debounced
    (`REMOVED_RESCAN_DEBOUNCE_MS`) backend rescan to drop now-empty dirs; a fresh
    `scanFolder` response rebuilds the tree. Watcher events before the initial
    scan lands are dropped (the scan is authoritative during boot).
- `projectScanScheduler.ts` — `useProjectScanScheduler`, the two effects behind
  `useProjectScan` (initial retrying scan + live-update subscription). It reads
  as orchestration only; the timer/fencing mechanics live in three focused
  modules it wires together: `scanSnapshot.ts` (the `ProjectScanSnapshot`
  state-shape helpers — `snapshotFor*` / `patchSnapshot`, no timers),
  `scanRetry.ts` (`retryDelay` backoff math + `useRequestIdFence`, the monotonic
  request-id fence both effects use to drop stale in-flight scans), and
  `healthUpdateScheduler.ts` (`createHealthUpdateScheduler` — owns the
  `METRIC_BATCH_MS` metric-batch queue, the structural-rescan debounce, the long
  `REMOVED_RESCAN_DEBOUNCE_MS` removed-file rescan, and the retrying backend
  rescan; the effect just forwards gated events to `handleEvent`/`dispose`).
- `scanResultPatch.ts` — pure (no React) `ScanResult`-patch helpers.
  `patchUpdatedFiles` builds one path→index map, clones only nodes whose metrics
  actually changed, and returns `prev` unchanged on a no-op (→ no render).
  `removeFile` drops a node and its links; `normalizeLinks` flattens d3's
  mutated `{source,target}` objects back to id strings.
- `useStructuralScan(data)` — memoises `data` keyed on `data.links` identity, so
  it returns a reference that changes **only on structural changes**, not on
  metric-only saves. Lets structure-only consumers (file/dir counts, legend rows,
  the filename search pass, workflow stack detection) skip an O(N) recompute +
  re-render per save. **The returned value carries stale metric fields by
  design** — only feed it to consumers that read structural fields
  (kind/ext/name/path/id); anything rendering health/loc/size keeps depending on
  live `data`.

### Key invariant

`patchUpdatedFiles` returns `{ ...prev, nodes }` on a metric-only patch, which
**keeps `prev.links` by reference** (the spread copies the same array); any
*structural* change mints a new `links` array. Two consumers depend on this
exact identity contract:
- `useStructuralScan`'s memo keys on `links` identity to detect "structure
  unchanged".
- `useGraphDataSync`'s cheap metric **fast-patch** tier keys on same-`links`
  identity (+ same node count / scan root / `history` ref) to patch fields in
  place without rebuilding sprites or reheating the d3 sim.

If you ever rebuild `links` on a metric-only patch, both fast-paths break and
every file save forces a full O(N) graph rebuild. See
`components/forceGraph/CLAUDE.md` for the consumer side.

## Persisted-toggle / settings hooks

Small per-project state helpers, mostly thin wrappers over `localStorage` or the
shared `userSettings.json` fetch:

- `useUserSettings(activeFolder)` — the **single** per-folder
  `userSettings.json` fetch; the slice hooks below read from its result instead
  of each fetching. `useHiddenExtensions` (per-ext graph visibility in
  `localStorage`; folder-switch persist guard extracted to `hiddenExtsPersist.ts`)
  · `useMetricsIgnoredExts` (exts skipped by the LOC/health overlays) ·
  `usePersistedToggle` (generic boolean ↔ `localStorage`) · `useActiveFolder`
  (canonical project path, seeded from `sessionStorage`, falls back to the
  backend default — boot retry in `resolveDefaultRoot.ts`) · `useSidebarWidth`
  (drag-resize + persist) ·
  `useSyncedRef` (a ref kept in sync with a value, for stable event handlers) ·
  `useStartupTerminalSync` (per-project startup-terminal list).

## Other shared hooks

- `useHarnessAvailability()` — live `{claude, pi, codex}` map (via
  `subscribeHarnesses`) + a `harnessAvailLoaded` flag, shared by every harness
  dropdown (task board / workflow overrides + steps / post-merge hook). Replaces
  the per-feature copies; each feature keeps its own selection/persistence.
- `usePiModelMenu()` — the curated "Pi — X" menu, read from the shared
  `../piModelMenuStore` (`piMenuStoreCore.ts` = pure `createPiMenuStore(fetcher)`
  core + the `getPiModels`-backed singleton). One cached list across all
  dropdowns; `notifyPiModelsChanged()` (called from `saveSettings` after a Pi
  providers/menu save) refetches and re-renders every mounted dropdown without a
  page reload. Built on `useSyncExternalStore` (the store's `getMenu` keeps a
  stable reference between loads).
- `useFocusTrap(open)` — shared modal/dialog focus management. Returns a ref for
  the dialog container; moves focus inside on open (respecting a child's
  `autoFocus`), wraps Tab/Shift+Tab within it, and restores focus to the opener
  on close. Used by `Modal`, `FloatingPanel`, and `TaskDetailOverlay`;
  Escape-to-close stays each wrapper's own concern.
- `useDismissOnOutside(open, ref, onClose)` — shared popover/menu dismissal.
  While `open`, a document `pointerdown` outside `ref`'s element and a window
  Escape `keydown` both call `onClose` (read through a ref, so its identity never
  re-attaches the listeners). Used by `sidebar/NewTerminalDropdown` and
  `sidebar/hooks/useTabContextMenu`. The graph's `forceGraph/hooks/useNodeContext
  Menu` is deliberately NOT on this hook: it's a different gesture (mousedown +
  `.closest()` class test + deferred attach, no Escape), and adapting it would
  need enough option flags to defeat the point.
