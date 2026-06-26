# forceGraph

3D file-tree DAG view. `components/ForceGraphView.tsx` is a re-export shim; the
coordinator is `forceGraph/ForceGraphView.tsx`. Hook detail in `hooks/CLAUDE.md`;
label physics in `labelPhysics/CLAUDE.md`.

## Two named subsystems (shared vocabulary)

- **Idle controller** (`idleController.ts`) — the render-on-demand gate: a
  reference-counted wrapper around `pauseAnimation`/`resumeAnimation` that
  suspends the RAF loop unless a **reason** is held (`engine`, `interact`,
  `refresh`, `labelPhysics`, `agents`; minus a tab-hidden gate). THE perf contract:
  a settled, un-interacted scene reaches 0 frames (see invariants).
- **Agent Presence Layer (APL)** (`agentOverlay*.ts` + `hooks/useAgentOverlay`)
  — where live Claude agents work: per agent a free-floating **presence node**,
  fading **focus beams** to files it touches, a file **label**, and a **satellite**
  per Task/Agent subagent. Lives in `graph.scene()` (NOT `graphData`), so an agent
  appearing/finishing never reheats the sim. Worktree (`task-activity`) + orange
  non-worktree (`agent-activity`) sessions alike.

## Module map

**Coordinator & chrome (React)**
- `ForceGraphView.tsx` — coordinator: holds `selected`/`hoverNode`, threads refs
  through `useGraphOverlays` + `useForceGraphInitialization`, composes the
  `Graph*` overlay components. Imperative syncs + keyboard live in focused hooks.
- `GraphHud` / `GraphSelectionChip` / `GraphContextMenu` / `GraphTaskModal` /
  `GraphSearchBar` / `GraphOverlayKey` / `GraphSettingsChrome` /
  `GraphSettingsPanel` — render-only HUD/chip/popover/modal/search/overlay-key/
  gear-FAB-settings-panel overlays.
- `HealthTooltip` (+ `HealthTooltipSections`/`healthTooltipMetrics`/
  `tooltipPosition`/`cursorTracker`/`healthScoreContributions`) — file-health hover
  tooltip; writes its own `transform` so cursor moves don't re-render React.
- `TimelineScrubber.tsx` (+ `timelineRange`/`useTimelineScrubberDrag`/`timelineDiff`/
  `timelineReset`) — git timeline scrubber UI + range math.

**Node sprites & recolor overlays**
- `nodeObjectFactory.ts` — `buildNodeObject`: the ghost/health/loc/dead/base
  sprite decision tree (recolor precedence health > loc > dead > base) + the
  change-ring/selection-halo sibling children. Handed to `nodeThreeObject`.
- `sprites` / `spriteShapes` / `spriteTextures` / `spritePicking` — per-(ext,
  shape,color) `SpriteMaterial` cache, shape geometry, canvas→`CanvasTexture`
  (sets `colorSpace = SRGBColorSpace`), sprite-quad pick bounds.
- `locOverlay` / `healthOverlay` / `deadCodeOverlay` / `labelsOverlay` — overlay
  configs + per-overlay registries. `deadCodeOverlay` is a pure recolor;
  `labelsOverlay.applyNodeLabelState` is the per-node Alt name-label toggle.
- `labelTexture` / `floatingLabelSprite` / `metricOverlayFactory` — shared,
  module-owned (refcount-guarded) label-texture/sprite/connector caches.
- `labelSync.ts` — in-place Alt-overlay delta walker (no `graph.refresh()`).
  `labelRepulsion` (facade) + `labelRepulsionFrames` (scene-frame-driven, holds
  `labelPhysics` only while labels move) + `labelPhysics/` (pure physics, own doc).

**Sibling-child ring/halo toggles ("the halo pattern")**
- `halo` + `selectionHaloSync`, `worktreeRing` (`W`), `changeRing` +
  `changeRingSync` + `changeRing{Materials,Textures}` (timeline git rings, two-part
  `W`-suppression). Each toggles a ring as a sibling child of the node root for
  only the changed ids — never `graph.refresh()`.
- `mountedNodes.ts` — cache-free shared helpers every delta walker reuses
  (`mountedNodes`/`mountedRoot`/`mountedNodesById`/`baseSizeFor`).

**Agent Presence Layer**
- `claudeNodeSprite.ts` — `makeClaudeNode` (presence disc+glow) /
  `makeSatelliteNode` (subagent ring).
- `agentOverlay.ts` — thin façade over the APL (`setAgents`/`addActivity`/
  `addSubagent*`/`tick`/`setSizes`/`isActive`/`destroy`) delegating to siblings
  `agentOverlay{Context,Constants,Types,PathIndex,Reconcile,Activity,Satellites,
  Beams,BeamMath,Tick,Labels,Placement}.ts` (pure math tested in `src/__tests__`).

**Idle / scene / motion drivers**
- `idleController.ts` + `idleController{Reasons,Loop,Engine,Interact}.ts` — reason
  ledger, pause/resume duty-cycle engine (deferred-pause microtask +
  re-entrant-resume guard + ~30fps slow-frame throttle), `engine` reason (+
  `isEngineHot()`), `interact` reason.
- `sceneFrameDriver.ts` — single `scene.onBeforeRender` fan-out; subscribe via
  `onFrame(graph, cb)` (fires only while the loop runs).
- `nodeMotionDriver.ts` + `motionSyncGate.ts` — fan-out over engine-tick/drag
  callbacks + the "re-upload positions this frame?" gate for batched renders.

**Batched (instanced) renderers**
- `instancedLinks.ts` / `instancedNodes.ts` — collapse the library's per-link
  `Line`s / per-node `Group`s into one `LineSegments` / a few `InstancedMesh`es
  to cut orbit-time draw calls. Default-on; re-upload positions only on node-motion
  frames; re-capture object arrays on every `graphData()` swap (`dataGeneration`
  invariant). Driven by `hooks/useBatchedLinks` / `hooks/useInstancedNodes`.

**Settings, physics, misc**
- `graphSettings.ts` — `GraphSettings`/`DEFAULT_SETTINGS`/`loadSettings`; perf
  fields `chargeTheta`/`repulsionMode`/`linkWidth`/`batchedLinks`/`batchedNodes`/
  `pixelRatio` (layout CPU `forceManyBody` and orbit CPU draw-calls+fill differ).
- `localRepulsionForce.ts` — O(N) linked-cell `charge` for `repulsionMode==='local'`.
  `sceneSetup.ts` — camera/OrbitControls lock + resize observer + `applyRenderPixelRatio`.
  `depthMap` + `useNodeDepthCache` — Alt-label depth bands; `menu.ts` /
  `renderOrders.ts` — right-click items / z-layer constants.

## Hooks

`hooks/` holds the coordinator's extracted effects (data sync, overlays, hold-key/
pin lifecycle, search, drag/hover, batched-render controllers, settings
render-vs-physics splits, the Escape chord). See `hooks/CLAUDE.md`.

## Load-bearing invariants (do not violate)

- **Render-on-demand.** Anything that animates must hold its idle reason *while*
  it animates and release it when it settles — never "hold while enabled". The
  APL holds `agents` **only while `tick()` reports motion** (distance-to-target
  `REST_EPS`); a "hold while any agent exists" hold pins the loop at ~60fps.
- **One-shot scene mutations must wake the loop.** While settled the loop is
  *paused*, so a one-shot change only paints if it wakes — `kick()` for motion,
  `wakeForRefresh()` for a set change (agent removal, selection halo, worktree
  ring, Alt labels). The motion gate alone leaves a stopped node painted.
- **Deferred pause via microtask.** The library reschedules its own RAF at frame
  end and `onEngineStop` fires *inside* that cycle, so a synchronous
  `pauseAnimation()` is overwritten and the loop never stops. All pauses route
  through `queueMicrotask` (cancel runs between frames); resumes stay synchronous
  + idempotent, guarded against re-entrancy in `idleControllerLoop`.
- **Label-registry teardown (GPU-buffer-leak guard).** Label/connector resources
  are module-owned + refcount-guarded: balance every `buildMeasuredLabelTexture`
  with a `releaseLabelTexture`; eviction skips in-use (refcount>0) textures; route
  every teardown through `clearAllLabelRegistries` (never `.clear()` a registry).
  Each connector gets its own `clone()`d geometry — the only thing
  `disposeLabelEntry` frees; `AgentOverlay.destroy` frees the agent-label cache.
- **`dataGeneration` re-capture.** Both batched controllers cache their node/link
  arrays at `rebuild()`. A full `graph.graphData(...)` swap replaces every object
  — including the git-history **ghost merge** that leaves `structuralData`
  unchanged — so `useGraphDataSync` bumps `dataGeneration` on *every* swap (rebuild
  effects depend on it), else the renderers freeze on stale objects.
- **Node-motion driver needs all three signals** (`onEngineTick`/`onNodeDrag`/
  `onNodeDragEnd`): once settled a drag can't re-tick the engine, so `onNodeDrag` is
  the reliable "a node moved" signal for the batched sync — not `isEngineHot()`.
- **Sprites use `colorSpace = SRGBColorSpace`** (sprite/ring/halo/label textures)
  so canvas colors match the Legend exactly.
- **Filtering goes through `nodeVisibility`/`linkVisibility`** (`hooks/
  useGraphFilter`), never structural add/remove, to keep the d3 sim stable.
- **Structure-only consumers key off `useStructuralScan(data)`, not `data`**
  (fresh ref per metric-only HealthUpdate). Only feed the structural ref to
  consumers that never read metric fields — it carries stale metrics by design.
- **Hover is gated off during a pointer drag** (`pointerDraggingRef`): the library
  raycasts hover every frame, so a rotate would otherwise fire `onHover` + a
  synchronous `flushSync`/tooltip mount per frame and stutter.
- **Batched-node pick proxy.** With `batchedNodes` on, the per-node base sprite
  stays mounted but `.visible = false` (three.js raycasts ignore `.visible`), so
  it remains the pick target and the halo/ring/label children still anchor to it.

## Camera

`up = (0,1,0)`; polar clamped to `[0, 0.75π]`; OrbitControls (not Trackball);
`dagMode = 'td'`. Configured in `sceneSetup.configureCameraControls`.
