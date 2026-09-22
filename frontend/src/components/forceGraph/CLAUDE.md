# forceGraph

3D file-tree DAG view. `components/ForceGraphView.tsx` is a re-export shim; the
coordinator is `forceGraph/ForceGraphView.tsx`. Hook detail in `hooks/CLAUDE.md`;
label physics in `labelPhysics/CLAUDE.md`.

## Two named subsystems (shared vocabulary)

- **Idle controller** (`idleController.ts`) — the render-on-demand gate: a
  reference-counted wrapper around `pauseAnimation`/`resumeAnimation` that
  suspends the RAF loop unless a **reason** is held (`engine`, `interact`,
  `refresh`, `labelPhysics`, `agents`, `halo`; minus a tab-hidden gate). THE perf
  contract: a settled, un-interacted scene reaches 0 frames (see invariants).
  `agents`/`labelPhysics`/`halo` are the *slow-only* reasons — when they're the
  only thing awake the loop duty-cycles to ~30fps.
- **Agent Presence Layer (APL)** (`agentOverlay*.ts` + `hooks/useAgentOverlay`)
  — where live Claude agents work: per agent a free-floating **presence node**,
  fading **focus beams** to files it touches, a file **label**, and a **satellite**
  per Task/Agent subagent. Lives in `graph.scene()` (NOT `graphData`), so an agent
  appearing/finishing never reheats the sim. Worktree (`task-activity`) + orange
  non-worktree (`agent-activity`) sessions alike.

## Module map

**Coordinator & chrome (React)**
- `ForceGraphView.tsx` — the exported component is a **retry shell** (WebGL
  faults, below) around the coordinator: holds `selected`/`hoverNode`, threads
  refs through `useGraphOverlays` + `useForceGraphInitialization`, and stays
  focused on graph lifecycle / scene runtime orchestration. Imperative syncs +
  keyboard live in focused hooks.
- `rendererStatus.ts` / `GraphRendererNotice.tsx` — **WebGL faults are expected,
  not bugs.** The graph owns the app's only long-lived WebGL context and the
  browser can refuse one outright: the per-page context budget is spent (each
  *active* xterm WebglAddon holds one too — see
  `terminal/useActiveTerminalWebgl`), or the GPU process is down after an
  out-of-memory kill, in which case Chrome withholds contexts until the
  **browser** restarts — a page reload does nothing. THREE throws
  `Error creating WebGL context.` out of `new ForceGraph3D`, and an exception
  escaping the init layout effect used to reach `<ErrorBoundary compact>` and
  blank the whole graph subtree behind a raw stack. So init catches it, the
  coordinator renders a recoverable notice over the dead viewport, and Retry
  **remounts the coordinator** — re-running init alone would leave every hook
  below wired to a graph instance that no longer exists. The same notice covers
  `webglcontextlost` (frozen canvas, previously silent) and clears itself on
  `webglcontextrestored`. Classification/copy is pure + unit-tested in
  `src/__tests__/rendererStatus.test.ts`.
- `useGraphViewChromeModel.ts` — shapes the coordinator's state into HUD,
  overlay-key, timeline, selection, context-menu, task-modal, toast, and settings
  chrome props (including counts, timeline range handler, and active-pin state).
- `GraphViewChrome.tsx` / `GraphViewOverlays.tsx` — render-only viewport wrapper
  and overlay composition.
- `GraphHud` / `GraphSelectionChip` / `GraphContextMenu` / `GraphTaskModal` /
  `GraphSearchBar` / `GraphOverlayKey` / `GraphSettingsChrome` /
  `GraphSettingsPanel` — render-only HUD/chip/popover/modal/search/overlay-key/
  gear-FAB-settings-panel overlays.
- `HealthTooltip` (+ `HealthTooltipSections`/`healthTooltipMetrics`/
  `tooltipPosition`/`cursorTracker`/`healthScoreContributions`) — file-health hover
  tooltip; writes its own `transform` so cursor moves don't re-render React.
- `TimelineScrubber.tsx` (+ `timelineRange`/`useTimelineScrubberDrag`/`timelineDiff`/
  `timelineReset`) — git timeline scrubber UI + range math. `timelineDiff`'s
  `buildGhostGraphData` mints one **ghost node per path in
  `GitHistoryResult.deletedPaths`** — the backend's `git ls-files`-derived set of
  history paths that no longer exist (`backend/src/gitHistory/deletedPaths.ts`) —
  all in forward-slash relative-to-root space via `relForward`. **Deriving that
  set here is not possible and must not be reattempted:** the scan is filtered to
  `SOURCE_EXTS` while `git log` is not, so "missing from the scan" ghosted every
  tracked image/font/`.ico`/`.gitignore` and drew it as deleted on the commit
  that added it; and "newest status in log order is `D`" is no better, since
  `git log` sorts by date across branches and Lattice branches constantly.
  Paths still present in the scan are skipped as a consistency guard (scan and
  history are fetched independently). **Parent-linking invariant:** a ghost links to the
  nearest existing *ancestor directory* node — walking `a/b/c` → `a/b` → `a` —
  and falls back to the scan-root node id when none exist, so deleted/renamed
  files always attach somewhere real rather than dangling. See
  `src/__tests__/timelineDiff.test.ts`. `hooks/useGitTimeline` keeps history **live**:
  besides the once-per-project fetch it subscribes to `subscribeGitStatus`
  (`/ws/git-status`) and re-fetches on a new signature (deduped vs the last one),
  so a commit / working-tree edit updates the commit list + dirty rings without a
  page refresh. `timelineRange.reconcileTimelineRange` remaps the scrubber range
  onto the new tick space so a live update never yanks the handles (tested in
  `src/__tests__/timelineRange.test.ts`).

**Node sprites & recolor overlays**
- `nodeObjectFactory.ts` — `buildNodeObject`: builds a node's THREE root by
  applying the decision from `spriteDecision.ts` as a flat sequence (build base
  sprite, hide-if-batched, attach change-ring/label/halo sibling children).
  Handed to `nodeThreeObject`.
- `spriteDecision.ts` — `decideSpriteState`: the pure ghost/health/loc/dead/base
  decision tree (recolor precedence health > loc > dead > base) returning a
  plain, THREE-free `SpriteDecision` (baseKind + hide-when-batched + which
  ring/label/halo to attach). While a metric view (health/loc/dead) is active it
  suppresses the change-ring + label (they obscure the coloring); ghosts +
  metrics-ignored files are hidden by `useGraphFilter` instead.
- `sprites` / `spriteShapes` / `spriteTextures` / `spritePicking` — per-(ext,
  shape,color) `SpriteMaterial` cache, shape geometry, canvas→`CanvasTexture`
  (sets `colorSpace = SRGBColorSpace`), sprite-quad pick bounds.
- `locOverlay` / `healthOverlay` / `deadCodeOverlay` / `labelsOverlay` — overlay
  configs + per-overlay registries. `deadCodeOverlay` is a pure recolor;
  `labelsOverlay.applyNodeLabelState` is the per-node Alt name-label toggle.
- `labelTexture` / `labelSpriteResources` / `floatingLabelSprite` /
  `metricOverlayFactory` — shared, module-owned (refcount-guarded)
  label-texture/sprite/connector caches. `labelSpriteResources` holds the four
  cache layers (label material, color, line material, connector geometry
  template) + `disposeLabelMaterial`, with the "never dispose a shared resource
  per-node" INVARIANT; `floatingLabelSprite` is just the public factories
  (`makeFloatingLabelSprite`/`makeConnectorLine`/`disposeLabelEntry`) that draw
  on them.
- `labelSync.ts` — in-place Alt-overlay delta walker (no `graph.refresh()`).
  `labelRepulsion` (facade) + `labelRepulsionFrames` (scene-frame-driven, holds
  `labelPhysics` only while labels move) + `labelPhysics/` (pure physics, own doc).

**Sibling-child ring/halo toggles ("the halo pattern")**
- `halo` + `selectionHaloSync` (toggle the halo per changed id) + the
  `useSelectionHaloPulse` hook. The halo is a Group of two shared-material
  sprites: a **ring** below the node body (an outline, `RING_RENDER_ORDER`) and
  an additive-white **glow** just above it (`SELECTION_GLOW_RENDER_ORDER`) that
  brightens the node itself. The pulse animates both shared materials (ring tint
  brighter/whiter ⇄ base, glow opacity 0 ⇄ peak) in lock-step while any node is
  selected — O(1) per frame regardless of selection size; holds the idle
  controller's slow-only `halo` reason only while selected. `worktreeRing` +
  `worktreeRingSync` (`W`): the ring's state is a fetched path→color snapshot,
  not something `decideSpriteState` can derive, so the sync publishes it on
  `worktreeRingsRef` (a `NodeObjectRefs` member) and `buildNodeObject`
  re-attaches the ring from it on every full rebuild — a metric-view toggle /
  size slider / batched-nodes flip / file-save rescan while `W` was active used
  to rebuild every root ring-less. `clearWorktreeRings` is a one-shot O(N)
  scene walk (never a remembered id set, which a rebuild would orphan). Pinned
  by `src/__tests__/worktreeRingRebuild.test.ts`. `changeRing` +
  `changeRingSync` + `changeRing{Materials,Textures}` (timeline git rings, two-part
  `W`-suppression). Each toggles a ring as a sibling child of the node root for
  only the changed ids — never `graph.refresh()`.
  `changeRingSync` also carries **ghost visibility**, and because it skips the
  digest it has to move the ghost's *link* by hand as well: the library's
  per-link object (`__lineObj`) plus a `getInstancedLinks(graph).rebuild()` for
  the batched buffer. Skipping either leaves the deleted-file line drawn into
  empty space after the disc vanishes. Its one escape hatch: a ghost that should
  show but has no `__threeObj` (an earlier `refresh()` ran while it was outside
  the scrubber window, and the digest drops filtered-out nodes from the scene
  entirely) falls back to `clearLabelsAndRefresh`, since there's nothing left to
  toggle. The in-place hide goes through `setGhostRootShown`, which also
  disables the subtree's layers: THREE's Raycaster ignores `.visible`, so a
  hidden ghost otherwise stayed hoverable/draggable over empty space (and stole
  hover from nodes behind it). Pinned by `src/__tests__/ghostLinkSync.test.ts`.
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
- `instancedLinks.ts` / `instancedNodes.ts` (+ `instancedBatching.ts` shared
  lifecycle helpers, `matrixBuffer.ts` shared Float32Array writers for the
  interleaved GPU buffers — named column-major matrix/vertex offsets, THREE-free) —
  collapse the library's per-link `Line`s / per-node
  `Group`s into one `LineSegments` / a few `InstancedMesh`es to cut orbit-time
  draw calls. Default-on; re-upload positions only on node-motion frames;
  re-capture object arrays on every `graphData()` swap (`dataGeneration`
  invariant). Driven by `hooks/useBatchedLinks` / `hooks/useInstancedNodes`.
  `instancedLinks` also stamps its controller onto the graph instance (mirrors
  `attachIdleController`) — `getInstancedLinks(graph)?.rebuild()` is how a
  non-React caller forces the visible-link re-read; `changeRingSync` needs it
  after toggling a ghost. A rebuild that runs before the library's debounced
  digest has hydrated link endpoints (string ids — `linkVisibility` can't judge
  those) is re-captured by `onFrame` once they hydrate, or links to hidden
  ghosts / hidden-ext files stayed drawn. Both controllers also rebuild when a
  metric view toggles (`metricOverlayActive`): that view hides metrics-ignored
  files via `nodeVisibility`, so a batched-node rebuild made during it dropped
  them — and they drew nothing after the view ended.

**Settings, physics, misc**
- `graphSettings.ts` — `GraphSettings`/`DEFAULT_SETTINGS`/`loadSettings`; perf
  fields `chargeTheta`/`repulsionMode`/`linkWidth`/`batchedLinks`/`batchedNodes`/
  `pixelRatio` (layout CPU `forceManyBody` and orbit CPU draw-calls+fill differ);
  "Spread" tab fields `alphaDecay`/`warmupTicks`/`collideRadius` (neutral/off by
  default) + `tidyLayoutOnLoad`/`tidySpread` (the radial untangle below — **on by
  default**); "Rendering" tab selection-glow fields
  `selectionGlowStrength`/`selectionGlowScale` (the pulsing bloom over selected
  nodes — see `halo.ts` + `hooks/useSelectionGlowSettings`).
- `localRepulsionForce.ts` — O(N) linked-cell `charge` for `repulsionMode==='local'`.
  `layoutShapeForces.ts` — `forceCollideXZ`, the optional, off-by-default X/Z-plane
  "Spread" force giving even, non-overlapping node spacing. Fades with `alpha`
  (settle contract) and skips Y (pinned by the DAG). Registered by
  `hooks/useGraphSettings`' `useLayoutShapeSettings` (with `alphaDecay`/`warmupTicks`)
  only while `collideRadius > 0`.
- `radialTidyLayout.ts` (`computeRadialTidyLayout`/`tidyRingStep`, pure/tested) +
  `hooks/useRadialTidyLayout` — the **on-load untangler**. The scan is a
  containment *tree*; the library's default phyllotaxis-spiral seed ignores it and
  the engine settles sibling subtrees into a tangled "cord nest". Instead we seed
  each node at its **radial tidy-tree** position — every subtree gets its own
  angular wedge (sized by leaf count), radius growing with directory depth — so
  sibling wedges never overlap and the seed is effectively planar (≈0 link
  crossings). The engine then settles *from* the seed: radially-symmetric forces
  preserve the angular separation while the global charge declumps each directory's
  file cluster into 2D area. `tidyRingStep` is adaptive (`≈ sqrt(N)*linkDistance /
  maxDepth`, floored at `dagLevelDistance`) so the seed lands at ~half the
  force-directed natural radius — compact enough that the engine expands *outward*
  from it (which declumps) rather than contracting (which freezes clumps). Runs
  once per project on first data populate (guarded against file-save re-scans) and
  on demand via the Spread tab's "Untangle now" button. **Apply + reheat are
  atomic** in one deferred macrotask: on load the engine is still hot from the
  data-load reheat, so writing the seed and leaving the reheat for a later frame
  lets the strong center repulsion scatter the crowded shallow nodes before they
  settle — re-tangling. Measured ~5–6× fewer X/Z link crossings than the raw
  library seed. On unless `tidyLayoutOnLoad` is off.
  `sceneSetup.ts` — camera/OrbitControls lock + resize observer + `applyRenderPixelRatio`.
  `cameraState.ts` — pure load/save/read of the persisted camera view (used by
  `hooks/useCameraPersistence`).
  `depthMap` + `useNodeDepthCache` — Alt-label depth bands; `menu.ts` /
  `renderOrders.ts` — right-click items / z-layer constants.
  `searchMatcher.ts` — `buildSearchRegExp` for the search bar's filename pass
  (wildcard/regex, kept in sync with the backend `search.ts` rules).

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
  with a `releaseLabelTexture`; eviction skips in-use (refcount>0) textures and
  evicts free ones (O(1), via the cache's `free` set) back down to the cap after
  an over-cap burst; the repulsion scratch list is reset when an overlay stops so
  it doesn't pin the last frame's sprites; route
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
  useGraphFilter`), never structural add/remove, to keep the d3 sim stable. Those
  accessors are only ever consulted by the library's digest (a `refresh()` or a
  `graphData()` swap), and a filtered-out node is *removed from the scene* with
  its bind attr deleted — not merely hidden. So anything that flips visibility
  BETWEEN digests (the timeline's ghost delta) must do all three itself: the node
  object, the per-link `__lineObj`, and a batched-links re-capture.
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
`dagMode = 'td'`. Configured in `sceneSetup.configureCameraControls`. The view
(position + orbit target — `up` is locked so those two fully determine it) is
persisted per project and restored across refresh/project switch by
`hooks/useCameraPersistence` (load/save/read in `cameraState.ts`).
