# forceGraph

3D file-tree DAG view. `components/ForceGraphView.tsx` is a re-export shim; the
coordinator is `forceGraph/ForceGraphView.tsx`. Hook detail in `hooks/CLAUDE.md`;
label physics in `labelPhysics/CLAUDE.md`.

## Two named subsystems (shared vocabulary)

- **Idle controller** (`idleController.ts`) — the render-on-demand gate: a
  reference-counted `pauseAnimation`/`resumeAnimation` wrapper. The RAF loop
  needs a held **reason** (`engine`, `interact`, `refresh`, `labelPhysics`,
  `agents`, `halo`) and is gated off for a hidden tab or collapsed container.
  A settled, un-interacted scene reaches 0 frames; when only the *slow-only*
  `agents`/`labelPhysics`/`halo` reasons remain, it duty-cycles to ~30fps.
- **Agent Presence Layer (APL)** (`agentOverlay*.ts` + `hooks/useAgentOverlay`)
  — where live agents (Claude, Codex, Pi) work: per agent a free-floating
  **presence node**, fading **focus beams** to files it touches, a file
  **label**, and a **satellite** per subagent (with its own file label).
  `graphSettings.ts` defaults `showSubagentLabels` to `false`: it controls the
  subagent type prefix (or bare type before a file exists), not satellite
  presence or current-file labels. APL lives in `graph.scene()` (NOT
  `graphData`), so an agent appearing/finishing never reheats the sim.
  Worktree (`task-activity`) + non-worktree (`agent-activity`)
  sessions alike — the latter orange, or white / blue for a terminal or workflow-step
  Codex / Pi (`taskColors.sessionColor`). Activity for an agent whose node hasn't arrived
  yet (its presence rides a different socket) is held in
  `agentActivityBuffer.ts` and replayed when it does — dropping it left a
  label-less dot.

## Module map

**Coordinator & chrome (React)**
- `ForceGraphView.tsx` — the exported component is a **retry shell** (WebGL
  faults, below) around the coordinator: holds `selected`/`hoverNode`, threads
  refs through `useGraphOverlays` + `useForceGraphInitialization`, and stays
  focused on graph lifecycle / scene runtime orchestration. Imperative syncs +
  keyboard live in focused hooks.
- `rendererStatus.ts` / `GraphRendererNotice.tsx` — classify initialization
  errors (including WebGL construction failures) and show a notice for them or
  `webglcontextlost`. A construction failure or context-loss event alone
  establishes neither OOM nor a GC defect. Retry **remounts the coordinator
  and its hooks**: re-running init alone would leave hooks wired to the old
  graph instance. `webglcontextrestored` clears the notice and wakes rendering.
  A browser restart may help, but is neither a guaranteed nor an exclusive
  cure; see the existing
  [browser memory troubleshooting and graph recovery advice](../../../README.md#browser-memory-troubleshooting).
  Classification coverage: [rendererStatus.test.ts](../../__tests__/rendererStatus.test.ts).
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
  `buildGhostGraphData` uses **`GitHistoryResult.deletedPaths`**, the backend's
  `git ls-files`-derived missing history paths (`backend/src/gitHistory/deletedPaths.ts`),
  normalized with `relForward`; paths still in the scan are skipped. Never infer
  deletion from scan absence (`SOURCE_EXTS` filters it) or the latest `git log`
  status (date order crosses branches). Ghosts link to the nearest existing
  **ancestor directory**, falling back to the scan root. `hooks/useGitTimeline`
  re-fetches on a new `subscribeGitStatus` signature; `reconcileTimelineRange`
  preserves handle positions in the new tick space. Coverage:
  [timelineDiff.test.ts](../../__tests__/timelineDiff.test.ts),
  [timelineRange.test.ts](../../__tests__/timelineRange.test.ts).

**Node sprites & recolor overlays**
- `nodeObjectFactory.ts` — `buildNodeObject` applies `spriteDecision.ts` to the
  node's THREE root, including sibling rings/labels/halos; passed to `nodeThreeObject`.
- `spriteDecision.ts` — `decideSpriteState`: the pure ghost/health/loc/dead/base
  decision tree (recolor precedence security > health > loc > dead > base) returning a
  plain, THREE-free `SpriteDecision` (baseKind + hide-when-batched + which
  ring/label/halo to attach). While a metric view (health/LOC/dead-code) is active
  it suppresses the change-ring + label (they obscure the coloring); ghosts +
  metrics-ignored files are hidden by `hooks/useGraphFilter.ts` instead.
  This is rendering visibility, separate from scanner exclusions and the user's
  ordinary hidden-extension controls.
  `frontend/src/api/types/settings.ts` owns `DEFAULT_METRICS_IGNORED_EXTS` and
  `effectiveMetricsIgnoredExts`; `frontend/src/hooks/useMetricsIgnoredExts.ts`
  supplies the effective per-project list. Absent `metricsIgnoredExts` uses
  defaults; explicit `[]` opts those files back into metric views.
- `sprites` / `spriteShapes` / `spriteTextures` / `spritePicking` — per-(ext,
  shape,color) `SpriteMaterial` cache, shape geometry, canvas→`CanvasTexture`
  (sets `colorSpace = SRGBColorSpace`), sprite-quad pick bounds.
- `spriteMaterialCache.ts` — `createSpriteMaterialCache` (`get`/`peek`/
  `disposeAll`) behind every module-level sprite-material cache;
  `disposeSharedGraphResources` disposes and empties them all, plus the halo
  singletons' GPU side, once per graph teardown (see `hooks/CLAUDE.md` for the
  order). Coverage:
  [spriteMaterialCache.test.ts](../../__tests__/spriteMaterialCache.test.ts).
  **Module-level caches survive remounts** (project switch, Retry,
  error-boundary reset) and are bounded by key, not by graph:
  - `sprites.materialFor`: one per `styleKey` (extensions, shapes and overlay
    recolors).
  - `claudeNodeSprite`'s `materialCache` / `satelliteMaterialCache` and
    `worktreeRing`'s cache: one material + texture per color. Slots are reused,
    but `taskColors.ts`'s id-hash fallback for slotless tasks can mean one
    color per task id.
  - `changeRingMaterials`: three ring kinds + one ghost. `haloResources`: two
    singletons (below).
  Removing a node, a ring or an agent (`AgentOverlay.destroy` included) never
  drops an entry; graph teardown is their only release. Label-texture caches
  (`labelsOverlay` / `metricOverlayFactory`) have their own owner, see
  `labelTexture.ts`.
- `locOverlay` / `healthOverlay` / `deadCodeOverlay` / `labelsOverlay` — overlay
  configs + per-overlay registries. `deadCodeOverlay` is a pure recolor;
  `labelsOverlay.applyNodeLabelState` is the per-node Alt name-label toggle.
- `securityOverlay` — pure per-file OpenGrep recolor preserving language shapes;
  path lookup normalizes Windows casing/separators. ERROR red, WARNING yellow,
  INFO blue, completely visited files with no shown findings green, unscanned
  or incomplete gray. `useSecurityOverlay` starts scans only from the Security
  chip; no automatic refresh scans. Security keeps config files visible even
  when their extensions are on the health/LOC metrics-ignore list.
- `measuredLabelTexture.ts` — lazy shared measuring context + fresh rasterized
  textures. `labelTexture.ts` owns cache keying, refcounts, free-entry eviction
  and texture/paired-material/canvas teardown. A cache miss finishes drawing
  before eviction/insertion. Ownership coverage:
  [labelTextureCache.test.ts](../../__tests__/labelTextureCache.test.ts).
- `labelSpriteResources` / `floatingLabelSprite` / `metricOverlayFactory` —
  module-owned shared sprite/connector caches. `labelSpriteResources` holds
  label materials, colors, line materials and connector geometry templates +
  `disposeLabelMaterial`; never dispose shared resources per node.
  `floatingLabelSprite` supplies `makeFloatingLabelSprite`/`makeConnectorLine`/
  `disposeLabelEntry`.
- `labelSync.ts` — in-place Alt-overlay delta walker (no `graph.refresh()`).
  `labelRepulsion` (facade) + `labelRepulsionFrames` (scene-frame-driven, holds
  `labelPhysics` only while labels move) + `labelPhysics/` (pure physics, own doc).

**Sibling-child ring/halo toggles ("the halo pattern")**
- `haloResources.ts` — owns the lazy ring/glow `CanvasTexture` and
  `SpriteMaterial` singletons. Every node borrows the same two materials and
  their textures. Once created, the JS objects are retained for the module
  lifetime. Their GPU side is not: three-forcegraph's `_deallocate` disposes
  the materials and maps attached to nodes on every `refresh()` and
  `_destructor`, and three re-uploads them on next use. The only explicit
  dispose is the teardown-only `disposeHaloResources`, called by
  `disposeSharedGraphResources` (`spriteMaterialCache.ts`) once per graph
  teardown; it keeps the singletons. Removing a halo must not dispose them.
- `halo.ts` — owns selection-glow settings, shared pulse/reset, and per-node
  Group attachment. The Group contains a ring below the body and an additive
  glow above it; removal only detaches the Group. Pulse/reset use
  `peekRingMaterial`/`peekGlowMaterial`, which do not allocate, so calling either
  before the first halo creates no canvases or GPU resources. The pulse updates
  both shared materials in O(1) per frame regardless of selection size.
- `selectionHaloSync` toggles changed ids without `graph.refresh()`;
  `hooks/useSelectionHaloPulse` holds the slow-only `halo` idle reason only while
  selected, then resets and wakes once. `hooks/useSelectionGlowSettings` pushes
  settings to `halo.ts`: strength is read live; scale rebuilds selected halos.
- `worktreeRing` + `worktreeRingSync` (`W`) — fetched path→color state lives in
  `worktreeRingsRef` (`NodeObjectRefs`), so `buildNodeObject` can re-attach rings
  on every full rebuild. `clearWorktreeRings` walks the current scene, never a
  remembered id set that a rebuild would orphan. Coverage:
  [worktreeRingRebuild.test.ts](../../__tests__/worktreeRingRebuild.test.ts).
- `changeRing` + `changeRingSync` + `changeRing{Materials,Textures}` — timeline
  rings with two-part `W` suppression. Like selection/worktree rings, these are
  sibling children toggled per changed id, without `graph.refresh()`.
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
  `makeSatelliteNode` (subagent ring). Their per-color materials are
  module-level and outlive `AgentOverlay.destroy`; graph teardown releases
  them (see `spriteMaterialCache.ts` above).
- `agentOverlay.ts` — thin façade over the APL (`setAgents`/`addActivity`/
  `addSubagent*`/`tick`/`setSizes`/`isActive`/`destroy`) delegating to siblings
  `agentOverlay{Context,Constants,Types,PathIndex,Reconcile,Activity,Satellites,
  Beams,BeamMath,Tick,Labels,LabelLayout,Placement}.ts` (pure math tested in
  `src/__tests__`). `hooks/useAgentOverlay.ts` supplies `showSubagentLabels` to
  `agentOverlay.ts`'s `setSizes`, which updates it each frame;
  `agentOverlayLabels.ts` formats the text.
  `AgentPathIndex.clear()` releases the indexed nodes array, path map and bounds
  immediately when the last agent is removed, on empty reconciliation and on
  destroy; inactive overlays may never receive another frame. A remaining sibling
  keeps the index, and the next addition rebuilds it through `ensure`. Coverage:
  [agentOverlayPathIndex.test.ts](../../__tests__/agentOverlayPathIndex.test.ts).
  `agentLabelRects.ts` owns the dependency-free rectangle types and pure
  `spreadLabelRects` packing (labels only slide along their node's side).
  `agentOverlayLabelLayout.ts` is the scene adapter and compatibility re-export;
  it projects/packs labels and manages displacement leaders. Layout snaps
  without an idle reason; an orbit already renders on `interact`.

**Idle / scene / motion drivers**
- `idleController.ts` + `idleController{Reasons,Loop,Engine,Interact}.ts` — reason
  ledger, pause/resume duty-cycle engine (deferred-pause microtask +
  re-entrant-resume guard + ~30fps slow-frame throttle), `engine` reason (+
  `isEngineHot()`), `interact` reason.
- `sceneFrameDriver.ts` (`onFrame`) + `nodeMotionDriver.ts` (`onNodeMotion` /
  `onNodeDragMove`) — single fan-outs over `scene.onBeforeRender` (only while
  the loop runs) and engine-tick/drag callbacks. Cached iteration arrays are
  rebuilt only on membership changes. Unsubscribe must remove membership and
  replace the relevant cached array immediately, including the final listener:
  a paused graph may never dispatch another frame. An in-flight dispatch keeps
  its local snapshot unchanged; additions/removals affect subsequent dispatches,
  never mutate the snapshot in place. Motion and drag have separate membership,
  caches and dirty flags; drag listeners run before motion listeners. Leave
  installed library callbacks callable with no listeners. Regression coverage:
  [sceneFrameDriver.test.ts](../../__tests__/sceneFrameDriver.test.ts) and
  [nodeMotionDriver.test.ts](../../__tests__/nodeMotionDriver.test.ts).
- `motionSyncGate.ts` — the batched-render position-upload gate: node motion,
  one trailing settle frame, or forced-dirty after a rebuild/re-enable.

**Batched (instanced) renderers**
- `instancedLinks.ts` / `instancedNodes.ts` — default-on controllers collapsing
  per-link `Line`s / per-node `Group`s into one `LineSegments` / per-style
  `InstancedMesh`es. Driven by `hooks/useBatchedLinks` / `hooks/useInstancedNodes`;
  position uploads follow `motionSyncGate`. `instancedBatching.ts` shares
  lifecycle helpers; `matrixBuffer.ts` supplies THREE-free column-major buffer
  writers. Re-capture on every `graphData()` swap (`dataGeneration` invariant).
  Both rebuild on metric-view toggles (`metricOverlayActive`) to re-read
  `nodeVisibility` / `linkVisibility`, including metrics-ignored files.
- `instancedLinks.ts` owns link capture, hydration re-capture, motion scheduling
  and the graph's controller stamp. Pre-hydration string endpoints must be
  re-captured by `onFrame` once hydrated so `linkVisibility` can filter them.
  `instancedLinkResources.ts` owns graph-local geometry/material/`LineSegments`/
  position storage. Growth must call `geometry.dispose()` while the old position
  attribute is still installed, before replacement. `setEnabled(false)` restores
  `linkThreeObject(null)` and detaches motion; `releaseResources` disposes the
  helper's resources and clears the controller's captured `links` +
  `needsRecapture`. Disabled rebuild/frame hooks allocate nothing; re-enable
  rebuilds from current `graphData()`. Disable keeps the stamp for
  `getInstancedLinks(graph)?.rebuild()` (`changeRingSync` ghost toggles);
  `dispose()` detaches motion, uses the same release path and removes the stamp
  only if still owned by this controller. Shared sprite/label materials retain
  separate owners. Growth/disable/re-enable coverage:
  [instancedLinks.test.ts](../../__tests__/instancedLinks.test.ts).
- `instancedNodes.ts` owns style grouping, motion/visibility orchestration and
  the shared quad. `instancedNodeResources.ts` owns billboard shader/material
  construction and style-mesh allocation/disposal. Each style mesh owns its
  `instanceMatrix` buffer and billboard material; growth replacement, style
  removal and disable release both. Borrowed sprite-cache textures and the
  controller's shared quad survive temporary disable; only final controller
  disposal frees the quad. Re-enable rebuilds from current `graphData()`.
  Recolor overlays hide batches and use per-node sprites; ghosts stay on the
  per-node path. Ownership coverage:
  [instancedNodes.test.ts](../../__tests__/instancedNodes.test.ts).

**Settings, physics, misc**
- `graphSettings.ts` — `GraphSettings`/`DEFAULT_SETTINGS`/`loadSettings`; perf
  fields `chargeTheta`/`repulsionMode`/`linkWidth`/`batchedLinks`/`batchedNodes`/
  `pixelRatio` (layout CPU `forceManyBody` and orbit CPU draw-calls+fill differ);
  `showLinks` (Rendering tab "Show links" checkbox, default on — off returns
  `false` from `useGraphFilter`'s `linkVisibility` and re-captures the batched
  buffer; render-only, the links still drive the layout);
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
  `hooks/useRadialTidyLayout` — default-on untangler: seeds the containment tree
  in separate angular wedges with an adaptive radius so the engine expands
  outward to declump. Runs once per project on first data populate, guarded
  against file-save rescans, and on demand via "Untangle now". **Apply + reheat
  must be atomic** in one deferred macrotask; a frame between them lets the
  already-hot engine scatter shallow nodes and re-tangle the seed.
- `sceneSetup.ts` — camera/OrbitControls lock + resize observer + `applyRenderPixelRatio`.
- `cameraState.ts` — pure persisted camera load/save/read for `hooks/useCameraPersistence`.
- `depthMap` + `useNodeDepthCache` — Alt-label depth bands; `menu.ts` /
  `renderOrders.ts` — right-click items / z-layer constants.
- `searchMatcher.ts` — file/folder-name wildcard/regex matching; keep it aligned
  with backend `search.ts` rules.

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
  ring, Alt labels, and a canvas resize — `renderer.setSize` clears the buffer
  without rendering, see `sceneSetup.createResizeObserver`). The motion gate
  alone leaves a stopped node painted.
- **Deferred pause via microtask.** The library reschedules its own RAF at frame
  end and `onEngineStop` fires *inside* that cycle, so a synchronous
  `pauseAnimation()` is overwritten and the loop never stops. All pauses route
  through `queueMicrotask` (cancel runs between frames); resumes stay synchronous
  + idempotent, guarded against re-entrancy in `idleControllerLoop`.
- **Label-registry teardown (GPU-buffer-leak guard).** Label/connector resources
  are module-owned + refcount-guarded: balance every `buildMeasuredLabelTexture`
  with a `releaseLabelTexture`; eviction skips in-use (refcount>0) textures and
  evicts free ones (O(1), via the cache's `free` set) back down to the cap as
  labels are released after an over-cap burst, even if the overlay stays off
  and no new texture is built. Eviction/owner teardown also zeroes each owned
  label canvas's dimensions to release native pixel storage without waiting
  for GC; free entries retained for reuse and live/shared labels keep their
  pixels. The repulsion scratch list is reset when an
  overlay stops so it doesn't pin the last frame's sprites; route
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

## Commands

Reference commands, with cwd `frontend/`: `npm run build` (build), `npm test`
(tests), `npx tsc -b` (type-check). These are documentation references;
Lattice task agents leave checks to the separate Run tests step. See
[test conventions](../../__tests__/CLAUDE.md).
