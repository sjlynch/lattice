# forceGraph/hooks

The coordinator's (`../ForceGraphView.tsx`) extracted effects. Each owns one
concern and reads volatile inputs through refs so listeners register once
instead of churning per keystroke/frame; pure logic lives in the non-`use*`
siblings. Module-level resources and invariants: [../CLAUDE.md](../CLAUDE.md).

## Coordinator phases

Called through two phase hooks, in this order (after the coordinator's shared
refs / hover / drag tracking, before `../useGraphViewChromeModel`). Straight
extractions: no added state, refs passed by identity (never copied), call order
and dependency arrays kept — effect order follows call order, so don't reorder
calls inside or across them.

- `useGraphSceneRuntime` — `useGraphOverlays` → `batchedNodesRef` mirror +
  `worktreeRingsRef` → `useForceGraphInitialization` → `useCameraPersistence`
  → `resetSelection` → `useGraphDataSync` → `useRadialTidyLayout` →
  `useBatchedLinks` → `useInstancedNodes` → `useNodeDragBehavior` →
  `useAgentOverlay` → `useWorktreeHighlight`.
- `useGraphInteraction` — `useGraphSearchController` → `useNodeContextMenu`
  (+ `closeContextMenu`) → `useBoxSelect` → `useGraphTaskCreation` →
  `useSelectionHaloSync` → `useSelectionHaloPulse` → `useSelectionGlowSettings`
  → `useMetricsIgnoreRefresh` → `useGraphViewKeyboard` →
  `useOverlayTooltipDismiss`.

## Init & data

- `useForceGraphInitialization` — mount-once layout effect: builds/configures
  `ForceGraph3D`, wires frame/motion drivers, forwards WebGL context
  lost/restored (restore wakes the loop). `onRendererFailure`/`onContextLost`/
  `onContextRestored` must be identity-stable: the effect captures them once.
- `forceGraphInitializationLifecycle.ts` — one idempotent teardown for failed
  setup and unmount; attempts every acquired cleanup once even if one throws,
  **in this order**: context-lost listener → context-restored listener → frame
  subscription → idle controller → resize observer → label registries
  (`clearAllLabelRegistries`, never per-node disposal) → graph `_destructor`
  (`graph.renderer()` captured first) → `disposeSharedGraphResources` →
  `renderer.forceContextLoss()` → `graphRef.current = null`. Why:
  `renderer.dispose()` keeps the context + drawing buffer until GC; only the
  forced loss frees them now and stops remounts piling contexts toward Chrome's
  per-page cap. Shared resources go while the context is live; the loss goes
  last (nothing after it touches GL) and raises no "GPU context lost" notice
  since the listeners went first. Both run for every returned graph, even after
  a throwing `_destructor`. Capture the graph before any setter can throw;
  record each cleanup slot as acquired. Failed setup clears the retry container
  (`replaceChildren()`) and reports the original error (a cleanup fault never
  replaces it); unmount rethrows the first cleanup error after all attempts.
- `useRadialTidyLayout` — on-load untangler: once per project on first populate
  (gated on `tidyLayoutOnLoad`) and via the returned `runLayout` ("Untangle
  now", always runs). **Apply + reheat are atomic in one deferred macrotask**:
  the defer dodges the first-reheat `state.layout` crash; a frame between them
  lets the hot engine scatter shallow nodes and re-tangle. A per-project guard
  ref stops file-save rescans re-seeding a graph the user has arranged.
- `useCameraPersistence` — position + orbit target per project
  (`lattice.graphCamera.<path>`, debounced off OrbitControls `change`). The
  library auto-fits only while the camera is at its construction default, so a
  restored view survives later data loads.
- `useGraphDataSync` — ScanResult + ghost history → `graphData`. A metric-only
  update takes the **fast-patch** path (fields written onto live sim nodes;
  `graph.refresh()` *only if H/Z/D is held* — otherwise every save rebuilds all
  N sprites and wakes the loop). Both tiers (links identity, then
  `shapeFingerprint`) share one id→node index. Bumps `dataGeneration` on every
  full swap.

## Overlays

- `useGraphOverlays` composes settings, timeline, the per-overlay hooks and
  `useGraphFilter`. `useHoldKeyMode` is the shared hold-key lifecycle
  (keydown/keyup/blur/visibilitychange + text-input guard) — reuse it for new
  overlays. Effective mode = `held || pinned` (`useOverlayPins`).
- `useWorktreeHighlight` (`W`) is the **only** overlay hook with live scene
  state: it strips its rings on deactivate, project change and unmount.
- `useGraphFilter` — swaps `nodeVisibility`/`linkVisibility` for `hiddenExts`
  (no sim restart) and wakes the loop so the digest paints with batching off.
  While H/Z/D is active it hides ghosts + metrics-ignored files, reading
  `metricOverlayActiveRef` live; the same flag short-circuits the timeline scrub
  delta and re-captures batched links. Security's own flag re-captures batched
  buffers when another metric view is pinned.
- `useGitTimeline` + `gitHistoryRefresh.ts` — one coordinator per project: one
  HTTP request at a time; status bursts keep only the newest follow-up signature
  (skipped if the response already matches); the initial websocket snapshot
  shares the initial fetch; obsolete results never flash old ghosts/rings;
  cleanup aborts and fences late publication; failures keep the last good
  history and scrubber range. `reconcileTimelineRange` keeps handle positions.

## Security

- `useSecurityOverlay` owns scans; **only explicit actions POST** (chip click
  with no saved result = one full scan; Update changed files; Full scan). Saved
  snapshots restore on mount; an idle chip click toggles them. Status finds an
  already-running scan and resumes polling its exact id. Background reads
  (focus, git change, 30 s) check freshness only, only while overlay or panel is
  open. Recolor waits for results; refreshes never reheat. A click while
  scanning cancels that exact id (after acceptance; failure allows retry). No
  shortcut or auto retry. The backend owns the timeout — a client deadline must
  never hide a running scan or its cancel; the countdown clock lives in the chip
  so the graph never re-renders. Project + request identity fence late results;
  project change/unmount stop waiting without cancelling an accepted scan;
  updates and cancels keep prior findings; a completed scan beats a late cancel.
- `useSecurityFindings` — review polling (3 s running, else 30 s, plus focus).
  Operation claims block duplicate writes yet allow cancelling a pending start;
  busy until every concurrent operation settles; abort + project-epoch fences.
  Mutations refresh reviews and saved results — never scan or launch a harness.
- `useSecurityGraphInteraction` — a plain file click opens the scoped findings
  panel (modified clicks keep selection); findings actions wake only across the
  camera tween.
- `useOpengrepAvailability` — hides Security until `status.available`. Reads on
  mount and focus/tab return, polls only during an engine install, carries the
  project (so the overlay can reconnect to a running scan), keeps the last
  confirmed value on failure, aborts on cleanup. Never starts a scan.

## Search, selection, drag, hover

- `useGraphSearchController` — wires `useGraphSearch` (filename + opt-in
  debounced contents pass → shared `selected`) and `useGraphSearchNavigation`
  (camera focus, waking across the tween). A full swap resets selection, so the
  "already applied" guard keys on `dataGeneration` and re-applies once per swap.
- `useSelectionHaloSync` — toggles changed ids + `wakeForRefresh`; never
  `graph.refresh()`.
- `useSelectionHaloPulse` — `../halo.ts::updateHaloPulse`, O(1) per frame over
  the two shared materials. Holds the slow-only `halo` reason only while
  selected; clearing releases it, resets (base tint, glow off) and wakes once;
  teardown unsubscribes, releases, resets. Pulse/reset never allocate.
- `useSelectionGlowSettings` — strength read live; a scale change rebuilds
  selected halos (`rebuildSelectionHalos`, O(selected)), no refresh.
- `useBoxSelect` (+ `boxSelectGeometry`, `orbitControlLock`); `useGraphViewKeyboard`
  (Escape chord: menu → search → select).
- `useGraphTaskCreation` — `submitTask` awaits `ensureGitRepo`
  (`components/gitSetup/`) before `createTask` (non-repo projects 400) and then
  resumes the create, so the prompt is never retyped.
- `useCanvasDragTracking` — sets `pointerDraggingRef` on pointerdown but
  suspends library interaction only after 4 px; stationary clicks must never
  call the interaction setters (they clear the picked node); release/cancel/
  unmount restore them.
- `useHoverNodeDebounce` (null-transition debounce, `flushSync` hover-in,
  ignores hover mid-drag); `useOverlayTooltipDismiss`;
  `usePointerLeaveTooltipDismiss` suspends library hover off-canvas, and
  `pointerOutsideRef` gates the hover setter and native-label accessor against a
  stale raycast.
- `useNodeDragBehavior` — physics-active drag (lifts `d3AlphaMin` so neighbours
  follow) + DAG-Y lock (re-pins `fy`).

## Batched renderers, APL, settings

- `useBatchedLinks` / `useInstancedNodes` — create the controller once, sync per
  frame via the frame driver, toggle on the setting, rebuild on graphData swap /
  hidden-ext / node-size / metric-view toggle / `dataGeneration`. Never depend
  on `structuralData`: a same-shape rescan replaces it without a graph swap →
  needless full upload + wake.
- `useAgentOverlay` — APL hook half: `AgentOverlay` lifecycle, merges
  in-progress tasks (`/ws/tasks`) + non-worktree sessions
  (`/ws/agent-sessions`), routes activity/subagent frames, ticks off the frame
  driver holding `agents` only while `tick` reports motion.
  `agentOverlayEvents.ts` — projection/routing + the satellite-reap beat (reap
  without a frame, then wake); subscriptions, replay, timers and loop ownership
  stay in the hook.
- `useGraphCounts` keys off `useStructuralScan` (metric saves skip the recount);
  small: `useNodeDepthCache`, `useMetricsIgnoreRefresh`, `useRefMirror`.
- `useGraphSettings*` / `usePerProjectGraphSettings` / `graphSettingsEffectUtils`
  — guarded render-vs-physics settings effects:
  [graphSettingsPanel/CLAUDE.md](../graphSettingsPanel/CLAUDE.md) → "Graph
  settings flow".

Tests: named after the module in `frontend/src/__tests__/`. Commands:
[frontend guide](../../../CLAUDE.md#build-type-check--tests).
