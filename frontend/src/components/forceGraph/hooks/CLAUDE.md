# forceGraph/hooks

The coordinator's (`../ForceGraphView.tsx`) extracted effects. Each owns one
concern and reads volatile inputs through refs so its listeners register once
and don't churn per keystroke/frame. Pure decision logic is split into sibling
non-hook modules (`graphDataSyncCore`, `boxSelectGeometry`, `orbitControlLock`,
`refresh`) and unit-tested where noted.

## Init & data

- `useForceGraphInitialization` — mounts `ForceGraph3D` once; lifecycle wiring
  only (accessor closures delegate to `nodeObjectFactory`, scene/camera to
  `sceneSetup`). Sets the d3 cooldown bounds and wires the frame/motion drivers.
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
  + `useGraphFilter` into one setup point.
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
  `hiddenExts` (no sim restart). While a metric view (`h`/`z`/`d`) is active it
  also hides ghost (deleted-file) nodes and metrics-ignored-ext files (`.json`,
  …) so the colored view stays uncluttered — reading `metricOverlayActiveRef`
  live, re-evaluated by the view-toggle refresh. The same flag short-circuits
  `useGitTimeline`'s scrub delta (no rings/ghosts painted while a view is held)
  and drives a `useBatchedLinks` re-capture (drop links to the hidden nodes).

## Search, selection, drag, hover

- `useGraphSearchController` — owns query + regex/contents toggles; wires
  `useGraphSearch` (filename pass + opt-in debounced contents pass, both feeding
  the shared `selected` set) and `useGraphSearchNavigation` (prev/next cursor +
  camera focus, pulsing `wakeForRefresh` across the tween).
- `useSelectionHaloSync` — in-place selection-halo delta (toggles only changed
  ids + `wakeForRefresh`, never a full refresh). `useSelectionHaloPulse` —
  animates the single shared halo material's tint (brighter/whiter ⇄ base) while
  any node is selected so rings pop in dense graphs; O(1) per frame, holds the
  idle controller's slow-only `halo` reason (30fps) only while selected.
  `useSelectionGlowSettings` — pushes the Rendering-tab glow knobs
  (`selectionGlowStrength`/`selectionGlowScale`) into `halo.ts` (strength read
  live per frame; a size change rebuilds the current selection's halos in place
  via `rebuildSelectionHalos`, O(selected), not a full refresh). `useBoxSelect` +
  `boxSelectGeometry` + `orbitControlLock` — shift-drag rectangle select.
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
- `useNodeDragBehavior` — physics-active drag (lifts `d3AlphaMin` so neighbours
  follow) + DAG-Y lock (re-pin `fy` so a drag slides only in the node's plane).

## Batched renderers & misc

- `useBatchedLinks` / `useInstancedNodes` — own the `instancedLinks`/
  `instancedNodes` controllers: create once, subscribe the per-frame sync to the
  scene frame driver, toggle on the setting, and **rebuild on a graphData swap /
  hidden-ext change / node-size change / `dataGeneration` bump** (every full
  `graphData()` swap, so they re-capture the fresh arrays after a ghost merge).
  Do not depend on `structuralData`: a same-shape backend rescan replaces that
  reference even when `useGraphDataSync` correctly skips a graph swap. Rebuilding
  in that case needlessly uploads all buffers and wakes the paused render loop.
- `useGraphCounts` — file/dir/hidden HUD counts memo, keyed off `useStructuralScan`
  so metric saves skip the recount. `useMetricsIgnoreRefresh` — refresh when the
  LOC/health ignore-ext set changes. `useRefMirror` / `refresh.ts` — small helpers.
- `useAgentOverlay` — hook half of the Agent Presence Layer: owns the
  `AgentOverlay` (`../agentOverlay`) lifecycle, merges in-progress *Claude* tasks
  (`/ws/tasks`) + non-worktree agent-session presence (`/ws/agent-sessions`) into
  its node set, routes `task-activity`/`agent-activity` beam + subagent-lifecycle
  frames, and drives the per-frame `tick` off the scene frame driver — holding the
  idle controller's `agents` reason only while `tick` reports motion. See the APL
  notes in `../CLAUDE.md`.

## Render-vs-physics splits (settings effects, all guarded)

`useGraphSettings` keeps its public `{ settings, setSettings, settingsRef }`
shape but is internally split by concern: per-project persistence/ref mirroring,
sprite/metric-label refresh, physics/repulsion application, layout-shape ("Spread"
tab) forces, pixel ratio, and link width.

Settings effects skip work on the initial mount and on an empty/unmounted graph
(`nodeThreeObject` reads `settingsRef` live, so the data-sync build already uses
current values — a pre-population refresh/reheat is a byte-identical wake):
- **Sizes** → clear label registries + `graph.refresh()` (no sim restart).
- **Physics** (`charge`/`link`/`decay`/`chargeTheta`/`repulsionMode`) → poke
  `d3Force` + `d3ReheatSimulation`; the force pokes run on *every* run (incl.
  setup) so persisted non-defaults aren't left at d3 defaults. `repulsionMode`
  swaps `forceManyBody`↔`forceLocalRepulsion` only when the active force changes.
- **Layout shape** (`alphaDecay`/`warmupTicks`/`collideRadius`) →
  `useLayoutShapeSettings`: push `d3AlphaDecay`/`warmupTicks` every run;
  install/remove the `forceCollideXZ` sim slot when its knob crosses 0; reheat on
  change to a populated graph (same guard/defer as physics). All neutral by
  default, so a default layout is untouched.
- **`linkWidth`** / **`pixelRatio`** → render-only prop + `wakeForRefresh`, no
  reheat. `batchedLinks`/`batchedNodes` are owned by their hooks, not effects.
