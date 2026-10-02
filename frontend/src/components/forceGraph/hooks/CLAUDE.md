# forceGraph/hooks

The coordinator's (`../ForceGraphView.tsx`) extracted effects. Each owns one
concern and reads volatile inputs through refs so its listeners register once
and don't churn per keystroke/frame. Pure decision logic is split into sibling
non-hook modules (`graphDataSyncCore`, `boxSelectGeometry`, `orbitControlLock`,
`refresh`) and unit-tested where noted.

## Coordinator phases

The coordinator calls the hooks below through two phase hooks, in this order
(after its own shared refs / hover / drag tracking, before
`../useGraphViewChromeModel`). Each is a straight extraction: it adds no state,
takes the coordinator's refs by identity (never copies), and keeps every
member's call order and dependency array — effect ordering follows call order,
so don't reorder calls inside or across them.

- `useGraphSceneRuntime` — `useGraphOverlays` → `batchedNodesRef` mirror +
  `worktreeRingsRef` → `useForceGraphInitialization` → `useCameraPersistence`
  → `resetSelection` → `useGraphDataSync` → `useRadialTidyLayout` →
  `useBatchedLinks` → `useInstancedNodes` → `useNodeDragBehavior` →
  `useAgentOverlay` → `useWorktreeHighlight`. Returns the overlay modes/settings,
  `dataGeneration`, `runLayout`, `resetSelection` and `worktreeActive`.
- `useGraphInteraction` — `useGraphSearchController` → `useNodeContextMenu`
  (+ `closeContextMenu`) → `useBoxSelect` → `useGraphTaskCreation` →
  `useSelectionHaloSync` → `useSelectionHaloPulse` → `useSelectionGlowSettings`
  → `useMetricsIgnoreRefresh` → `useGraphViewKeyboard` →
  `useOverlayTooltipDismiss`. Returns `contextMenu`, `dragRect`, `openMenuItem`,
  `toast`, and `search` / `taskModal` already shaped for the chrome model.

## Init & data

- `useForceGraphInitialization` — once-mounted layout effect supplying
  `ForceGraph3D` construction/configuration and resource registration to the
  lifecycle helper below. Accessor closures read live refs via
  `nodeObjectFactory`; scene/camera setup delegates to `sceneSetup`. Sets d3
  cooldown bounds, wires frame/motion drivers, and forwards
  `webglcontextlost`/`webglcontextrestored`, waking the idle loop on restore.
  `onRendererFailure`, `onContextLost`, and `onContextRestored` must be
  identity-stable: the effect mounts once and captures them. See
  `../CLAUDE.md` → `rendererStatus.ts`.
- `forceGraphInitializationLifecycle.ts` — `initializeForceGraphLifecycle`
  owns partial setup failures and normal unmount. Captures the returned graph
  before any configuration setter can throw; records cleanup slots immediately
  as resources are acquired. Both paths share an idempotent teardown, attempting
  every acquired cleanup once even if one throws, in this order: context-lost
  listener → context-restored listener → frame subscription → idle controller →
  resize observer → label registries → graph `_destructor` (`graph.renderer()`
  captured just before) → shared resources (`disposeSharedResources` =
  `../spriteMaterialCache`'s `disposeSharedGraphResources`) →
  `renderer.forceContextLoss()` → `graphRef.current = null`. The destructor's
  `renderer.dispose()` keeps the context and its drawing buffer until a GC;
  only the context loss frees them now and stops remounts piling contexts up
  toward Chrome's per-page limit. Shared resources go while the context is live
  (dropping the old renderer's `dispose` listeners); the loss goes last, so
  nothing after it touches GL, and the listeners removed first mean it raises no
  "GPU context lost" notice. Both run once for every returned graph, including
  after a throwing `_destructor`. Failed setup also clears the retry container
  with `replaceChildren()` before reporting the original renderer error through
  `onRendererFailure`; cleanup faults cannot replace it. Normal unmount propagates
  the first cleanup error only after all remaining attempts. A constructor that
  throws provides no returned instance to own, destroy or lose. Shared label
  resources are released through `clearAllLabelRegistries`, never ad hoc
  per-node disposal.
  See [lifecycle tests](../../../__tests__/forceGraphInitializationLifecycle.test.ts)
  for configuration/registration fault injection, cleanup order/idempotence,
  context loss, shared-resource disposal and retry-container behavior.
- `useRadialTidyLayout` — the on-load untangler. Fires once per project on first
  data populate (and on demand via the returned `runLayout`, wired to the Spread
  tab's "Untangle now" button): seeds each node at its radial tidy-tree X/Z
  (`../radialTidyLayout.computeRadialTidyLayout` — every subtree in its own angular
  wedge sized by leaf count, radius ∝ directory depth) so sibling subtrees can't
  tangle, then lets the engine settle from that seed. **Apply + reheat are atomic**
  in one deferred macrotask (the defer dodges the first-reheat `state.layout` crash;
  the atomicity stops the still-hot load engine from scattering the crowded shallow
  nodes between write and reheat — which re-tangles). A per-project guard ref stops
  file-save re-scans from re-seeding a graph the user has since arranged. Auto-run
  gated on `tidyLayoutOnLoad` (on by default); the manual trigger always runs.
- `useCameraPersistence` — persists the camera (position + orbit target) per
  project to `localStorage` (`lattice.graphCamera.<path>`, debounced off the
  OrbitControls `change` event via `../cameraState`) and re-aims it to the saved
  view on mount / project switch, so a page refresh keeps the vantage point. The
  library only auto-fits while the camera is at its construction default, so a
  restored non-default view survives later data loads.
- `useGraphDataSync` — pushes ScanResult + ghost history into `graphData`. A
  metric-only HealthUpdate (same node ids/links) takes the **fast-patch path**:
  fields are written onto the in-place sim nodes and `graph.refresh()` runs
  *only if an H/Z/D overlay is held* (those are the only views that render the
  patched fields) — an unconditional refresh would rebuild all N sprites and wake
  the loop on every file save. Two fast-patch tiers (cheap links-identity
  pre-check, then `shapeFingerprint` fallback) share one cached id→sim-node
  index. Bumps `dataGeneration` on every full swap (batched-renderer re-capture).
  Pure shape logic in `graphDataSyncCore.ts` (tested).
- `useNodeDepthCache` — cached path-depth map for Alt labels, keyed off a cheap
  structural fingerprint (`../depthMap`).

## Overlays

- `useGitTimeline` owns one `gitHistoryRefresh` coordinator per project: one
  HTTP request may run at a time, status bursts retain only the newest follow-up
  signature, and a response already matching it skips that follow-up. An initial
  websocket snapshot shares the initial HTTP fetch. Obsolete results do not
  flash old ghost/ring sets; cleanup aborts HTTP and fences late publication.
  Background failures retain the last good history and scrubber range.
- `useGraphOverlays` — composes `useGraphSettings` + `useGitTimeline` +
  `useLocOverlay` + `useHealthOverlay` + `useDeadCodeOverlay` + `useLabelsOverlay`
  + `useSecurityOverlay` + `useGraphFilter` into one setup point.
- `useSecurityOverlay` — explicit Security chip activation starts one OpenGrep
  scan, polls its exact id, and refreshes colors without reheating the layout.
  Shows a chip spinner, an ETA based on the previous scan, and completed duration.
  On refresh/project open, status discovers an already running scan and resumes
  GET polling of its exact id; only clicks POST. The countdown uses the backend
  start time, shows "Estimating…" without history, and keeps spinning past the
  estimate — until `OPENGREP_GRAPH_SCAN_TIMEOUT_MS` (12 min, `api/opengrep.ts`,
  timed from when this mount began waiting, not the backend start). Then the
  client stops polling and the chip turns off with a "still running" error but
  cancels nothing: the backend scan may still be running (a click gets 409
  `busy`). This mount won't re-attach that id; a remount will. Its clock stays inside the chip so it never rerenders the graph.
  Security recolor/visibility activates only when results arrive. A second click
  while scanning cancels that exact id and shows "Cancelling…" until confirmed;
  early cancellation waits for acceptance, and failed cancellation permits retry.
  No shortcut or automatic scan retry. Project-scoped results and request identity fence
  late completion; project change/unmount abort waiting without cancelling an
  already accepted backend scan. Toggling off and back on starts a fresh scan.
- `useOpengrepAvailability` — hides Security until `status.available` confirms
  a usable engine (managed or PATH). Reads status on mount and window focus/tab
  return, shares Settings' status responses, and polls only during an engine
  installation so completion is noticed even if Settings closes. Reads include
  the active project so `useSecurityOverlay` can reconnect to a running scan.
  Shared project snapshots are scoped independently from machine availability.
  Failed reads retain last confirmed availability. Cleanup aborts HTTP and removes listeners
  and timers. Availability changes never start a scan.
- `useHoldKeyMode` — the shared hold-key chord lifecycle (keydown/keyup/blur/
  visibilitychange + text-input guard) behind every overlay. `momentaryLetterMode`
  builds H/Z/D/W handlers; Alt supplies bespoke ones. Reuse this for new overlays.
- `useOverlayPins` — pin state (`{health,loc,dead,worktree,labels}` + `togglePin`);
  each overlay's effective mode is `held || pinned`. `useOverlayActive` folds those
  into the `GraphOverlayKey` chips' lit record.
- `useLocOverlay` / `useHealthOverlay` / `useDeadCodeOverlay` / `useLabelsOverlay`
  — per-overlay mode + side effects. `useWorktreeHighlight` is the `W` overlay and
  the **only** one with live scene state to tear down (fetches worktree-modified
  files, rings them per task color, strips on deactivate/project-change/unmount).
- `useGraphFilter` — swaps the `nodeVisibility`/`linkVisibility` accessors for
  `hiddenExts` (no sim restart) and wakes the idle loop so the digest's scene
  change paints even with the batched renderers off. While a metric view (`h`/`z`/`d`) is active it
  also hides ghost (deleted-file) nodes and metrics-ignored-ext files (`.json`,
  …) so the colored view stays uncluttered — reading `metricOverlayActiveRef`
  live, re-evaluated by the view-toggle refresh. The same flag short-circuits
  `useGitTimeline`'s scrub delta (no rings/ghosts painted while a view is held)
  and drives a `useBatchedLinks` re-capture (drop links to the hidden nodes).
  Security hides ghosts but keeps metrics-ignored config/prose files visible;
  its own flag also recaptures batched buffers when another metric view is pinned.

## Search, selection, drag, hover

- `useGraphSearchController` — owns query + regex/contents toggles; wires
  `useGraphSearch` (filename pass + opt-in debounced contents pass, both feeding
  the shared `selected` set) and `useGraphSearchNavigation` (prev/next cursor +
  camera focus, pulsing `wakeForRefresh` across the tween). `useGraphSearch`
  takes `useGraphDataSync`'s `dataGeneration`: a full structural swap resets the
  shared selection, so the "already applied" guard is keyed on the generation
  and the same match set is re-applied once after every swap (search halos used
  to vanish on the first rescan).
- `useSelectionHaloSync` — toggles only changed ids + `wakeForRefresh`; never
  `graph.refresh()`.
- `useSelectionHaloPulse` — `../halo.ts::updateHaloPulse` animates two shared
  materials in lock-step: ring tint (base ⇄ brighter/whiter) and additive glow
  opacity (0 ⇄ peak). O(1) per frame regardless of selected-node count.
  Allocation belongs to `../haloResources.ts`; see the [parent resource
  guide](../CLAUDE.md) for full ownership details. The hook owns its `onFrame`
  subscription and holds the idle controller's slow-only `halo` reason only
  while selected (~30fps when no faster reason is held). Clearing selection
  releases the reason, resets both existing materials (base ring tint, glow off)
  and calls `wakeForRefresh` once. Teardown unsubscribes, releases any held
  reason and resets; neither pulse nor reset allocates resources.
- `useSelectionGlowSettings` — pushes `selectionGlowStrength`/
  `selectionGlowScale` into `halo.ts`. Strength is read live per frame; a scale
  change rebuilds the current selection's halos in place via
  `rebuildSelectionHalos` (O(selected)), without `graph.refresh()`.
- `useBoxSelect` + `boxSelectGeometry` + `orbitControlLock` — shift-drag rectangle
  select.
- `useNodeContextMenu` — right-click popover. `useGraphTaskCreation` — create-task
  modal state; `submitTask` runs `ensureGitRepo` (`components/gitSetup/`) before
  `createTask`, since a non-repo project 400s the create — this is the graph's
  copy of the task board's Git Setup interception, and it resumes the create
  afterwards rather than making the user retype the prompt.
  `useGraphViewKeyboard` — the Escape chord (menu → search → select).
- `useCanvasDragTracking` — drives `pointerDraggingRef` + suspends pointer
  interaction during a drag. `useHoverNodeDebounce` — hover tooltip state + the
  null-transition debounce + the `flushSync` hover-in; ignores hover mid-drag.
  `useOverlayTooltipDismiss` — clears a stale tooltip when an LOC/health view ends.
  `usePointerLeaveTooltipDismiss` — hides the React + native node tooltips when
  the cursor leaves the canvas (navbar, terminal panel, HUD panels) and suspends
  library hover until it re-enters; `pointerOutsideRef` also gates the hover
  setter and the native-label accessor against a stale on-canvas raycast.
- `useNodeDragBehavior` — physics-active drag (lifts `d3AlphaMin` so neighbours
  follow) + DAG-Y lock (re-pin `fy` so a drag slides only in the node's plane).

## Batched renderers & misc

- `useBatchedLinks` / `useInstancedNodes` — own the `instancedLinks`/
  `instancedNodes` controllers: create once, subscribe the per-frame sync to the
  scene frame driver, toggle on the setting, and **rebuild on a graphData swap /
  hidden-ext change / node-size change / metric-view toggle /
  `dataGeneration` bump** (every full
  `graphData()` swap, so they re-capture the fresh arrays after a ghost merge).
  Do not depend on `structuralData`: a same-shape backend rescan replaces that
  reference even when `useGraphDataSync` correctly skips a graph swap. Rebuilding
  in that case needlessly uploads all buffers and wakes the paused render loop.
- `useGraphCounts` — file/dir/hidden HUD counts memo, keyed off `useStructuralScan`
  so metric saves skip the recount. `useMetricsIgnoreRefresh` — refresh when the
  LOC/health ignore-ext set changes. `useRefMirror` / `refresh.ts` — small helpers.
- `useAgentOverlay` — hook half of the Agent Presence Layer: owns the
  `AgentOverlay` (`../agentOverlay`) lifecycle, merges in-progress Claude, Codex,
  and Pi tasks (`/ws/tasks`) + non-worktree agent-session presence
  (`/ws/agent-sessions`) into its node set, routes
  `task-activity`/`agent-activity` beam + subagent-lifecycle
  frames, and drives the per-frame `tick` off the scene frame driver — holding the
  idle controller's `agents` reason only while `tick` reports motion. See the APL
  notes in `../CLAUDE.md`.
- `agentOverlayEvents` — descriptor projection/equality, activity/lifecycle
  routing, and the satellite-reap timer beat (`reapStaleSatellites`: reaps
  without a frame, then wakes the loop), using the hook's existing buffer,
  timestamp, and kick/refresh callbacks; subscriptions, pending replay, timers
  and render-loop ownership stay in the hook.

## Render-vs-physics splits (settings effects, all guarded)

`useGraphSettings` keeps its public `{ settings, setSettings, settingsRef }`
shape but is internally split by concern: per-project persistence/ref mirroring,
sprite/metric-label refresh, physics/repulsion application, layout-shape ("Spread"
tab) forces, pixel ratio, and link width. Files:
- `usePerProjectGraphSettings.ts` — per-project persistence + `settingsRef` mirror.
- `useGraphSettingsSprites.ts` — `useSpriteAndMetricLabelRefresh` (+ `SPRITE_REFRESH_DEBOUNCE_MS`).
- `useGraphSettingsPhysics.ts` — `usePhysicsAndRepulsionSettings`.
- `useGraphSettingsLayoutShape.ts` — `useLayoutShapeSettings`.
- `useGraphSettingsRendering.ts` — `useRenderPixelRatioSetting` + `useLinkWidthSetting`.
- `graphSettingsEffectUtils.ts` — shared `GraphRef` type + `hasMountedNodes` (the empty-graph guard).

Settings effects skip work on the initial mount and on an empty/unmounted graph
(`nodeThreeObject` reads `settingsRef` live, so the data-sync build already uses
current values — a pre-population refresh/reheat is a byte-identical wake):
- **Sizes** → clear label registries + `graph.refresh()` (no sim restart),
  trailing-debounced (`SPRITE_REFRESH_DEBOUNCE_MS`): the sliders fire a change
  per pointer move and the refresh rebuilds every sprite, so a drag pays one
  rebuild when it settles. Persistence (`usePerProjectGraphSettings`) is
  likewise debounced (`SETTINGS_PERSIST_DEBOUNCE_MS`), with the pending save
  flushed on unmount and before a save for another project.
- **Physics** (`charge`/`link`/`decay`/`chargeTheta`/`repulsionMode`) → poke
  `d3Force` + `d3ReheatSimulation`; the force pokes run on *every* run (incl.
  setup) so persisted non-defaults aren't left at d3 defaults. `repulsionMode`
  swaps `forceManyBody`↔`forceLocalRepulsion` only when the active force changes.
  After replacement, the detached cached charge force is initialized with an
  empty node array; reattachment supplies the current simulation nodes/context.
- **Layout shape** (`alphaDecay`/`warmupTicks`/`collideRadius`) →
  `useLayoutShapeSettings`: push `d3AlphaDecay`/`warmupTicks` every run;
  install/remove the `forceCollideXZ` sim slot when its knob crosses 0; reheat on
  change to a populated graph (same guard/defer as physics). Not neutral by
  default: `alphaDecay` 0.014 (d3: 0.0228) and `warmupTicks` 15 shape every
  default layout; only `collideRadius` (0) is off.
  `applyCollisionRadius` drops the cached collision closure after removal,
  releasing its nodes/scratch buffers; re-enable creates a fresh force.
- **`linkWidth`** / **`pixelRatio`** → render-only prop + `wakeForRefresh`, no
  reheat. `batchedLinks`/`batchedNodes` are owned by their hooks, not effects.

## Commands

From `frontend/`: `npm run build` (build), `npm test` (tests), `npx tsc -b`
(type-check). See the [frontend command guide](../../../CLAUDE.md#build-type-check--tests).
