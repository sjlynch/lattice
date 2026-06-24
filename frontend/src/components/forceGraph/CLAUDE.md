# forceGraph

3D file-tree view. `ForceGraphView.tsx` (parent dir) is a re-export shim.

## Named subsystems (shared vocabulary)

Two cooperating subsystems are easy to confuse — name them precisely when
asking for fixes/reviews:

- **Idle controller** (`idleController.ts`) — the render-on-demand gate. A
  reference-counted wrapper around the library's `pauseAnimation` /
  `resumeAnimation` that suspends the RAF render loop whenever nothing needs
  painting. The loop runs only while some **reason** is held: `engine` (d3 sim
  hot), `interact` (pointer/wheel, short tail), `refresh` (sprite rebuild
  tail), `labelPhysics` (an LOC/health/Alt overlay repulsion loop), or `agents`
  (the Agent Presence Layer has motion to paint). Tab-hidden is a negative
  gate. This is THE performance contract for the whole view: a fully settled,
  un-interacted scene must reach 0 render frames. Any feature that animates
  must (a) hold a reason while it animates and (b) release it the moment it
  settles — never hold "while the feature is enabled". Per-frame work hangs off
  the **scene frame driver** (`sceneFrameDriver.ts`): one
  `scene.onBeforeRender` fan-out (registered once at init) that runs each
  subscriber's callback at the head of every real render. Subscribe with
  `onFrame(graph, cb)` instead of wrapping `onBeforeRender` yourself — callbacks
  fire only while the loop runs, so any change that wakes the loop (via some
  reason) re-runs every callback for free; this is what lets the APL + label
  overlays self-stop yet stay correct.

- **Agent Presence Layer (APL)** (`agentOverlay.ts` + `agentOverlay*.ts` +
  `hooks/useAgentOverlay.ts`) — the overlay that shows where live Claude agents
  are working. Per agent it draws a **presence node** (a free-floating Claude
  node hovering above the graph), zero-or-more **focus beams** (node → a file
  it's touching, the current file persistent and older ones fading on a TTL),
  and a **file label**; all nodes float on a shared **hover line** a steady
  height above the graph top. The APL lives directly in `graph.scene()` (NOT in
  `graphData`), so an agent appearing/finishing never reheats the sim.

  **Subagent satellites.** Each Task/Agent subagent the main Claude spawns shows
  as a smaller **satellite** node (ring sprite, parent's color) tethered to and
  *following* the parent — it sits at a fixed golden-angle ring slot
  (`satelliteOffset`) and never orbits for effect (perpetual motion would pin
  the loop). A satellite has its own (slightly dimmer) focus beams and a small
  **type label** (`agent_type`, e.g. `Explore`). Driven by Claude's
  `SubagentStart`/`SubagentStop` hooks (→ a `lifecycle` activity event → a
  satellite appears/disappears) and the subagent's own tool-use hooks (which
  carry `agent_id` → a `subagentId`-tagged activity event → the satellite's
  beam). The parent node's centroid folds in its satellites' beam endpoints, so
  it sits over the whole cluster's work even when it has delegated everything. A
  missed `SubagentStop` is reaped by a generous idle-TTL once the satellite has
  no live beam (mirrors the backend session registry's safety net); parent
  removal disposes all its satellites. Works for every Claude node — worktree
  tasks (`task-activity`) and the orange non-worktree / project-instrumented
  sessions (`agent-activity`) alike.

  **APL ⇄ idle-controller contract (read before touching either).** The APL is
  ticked from the graph's *real* render frames via the shared scene frame driver
  (`onFrame`), not a private RAF — so it updates exactly when the scene paints,
  and tracks moving file nodes for free whenever the loop is already running
  (engine/interact).
  `AgentOverlay.tick()` returns whether it still has **self-driven motion** (a
  node easing toward its target, the hover line settling, or a beam fading);
  `useAgentOverlay` holds the idle controller's `agents` reason **only while
  that's true** and releases it the frame it settles. Rest is judged by
  distance-to-target (within `REST_EPS`), so nodes settle on target rather than
  stalling short. *Regression guarded here:* the APL originally held `agents`
  for the entire lifetime of any in-progress agent (`isActive()` = "an agent
  exists"), which pinned the render loop at ~60fps/20–30% CPU the whole time a
  task ran — defeating render-on-demand. Do not reintroduce a "hold while any
  agent exists" hold; gate on motion. `isActive()` is now only a cheap
  per-frame early-out.

  **Cleanup contract (a stale node = a missed wake).** Because the loop is
  *paused* whenever the APL is settled, a change that should be visible only
  paints if it also wakes the loop. The motion-gated `agents` reason covers
  ongoing easing/fading, but a **one-shot set change is not motion** — when a
  session stops (Stop hook → task leaves `in_progress`, or `SessionEnd` →
  `unregisterAgentSession`), `setAgents` deletes the node/label/beams from the
  scene group on an *already-settled* (loop-paused) frame, so the deletion would
  never be drawn. `setAgents` therefore returns whether the set changed and
  `useAgentOverlay.applyMerged` calls `wakeForRefresh()` on a change — the same
  guaranteed short frame tail every other one-shot scene mutator uses (selection
  halo, worktree ring, Alt labels). Rule: **any mutation of the agent set/beams
  must wake the loop** (`kick()` for motion, `wakeForRefresh()` for a one-shot
  set change); relying on the motion gate alone leaves a stopped agent's node
  painted on screen until the next unrelated wake. NB: this is the *render* half
  only — if a node lingers, first confirm the agent actually left the data
  (task status flipped / `agentSessions` unregistered). A non-worktree session
  that never fires `SessionEnd` (terminal hard-killed, or started before the
  project hooks were installed) only clears via `agentSessions`' idle-TTL /
  max-age sweep, which looks like "no cleanup" until the sweep fires.

## Modules

- `ForceGraphView.tsx` — coordinator. Holds `selected`/`hoverNode`/`showSettings`,
  threads refs through `useGraphOverlays` + `useForceGraphInitialization`, and
  composes the small `Graph*` overlay components below. Each remaining
  `useEffect` is one concern: selection-refresh, Escape key, counts memo.
- `nodeObjectFactory.ts` — `buildNodeObject(node, refs)` + `nativeNodeLabel(node)`.
  The decision tree for ghost vs health vs LOC vs dead-code vs base sprite
  (+ change-ring and selection-halo, both attached as sibling children of the
  root, ordered behind/around the base by renderOrder + size) lives here; the
  init hook just hands the closure to `ForceGraph3D.nodeThreeObject`. Recolor precedence is
  health > loc > dead > base; health/loc skip `metricsIgnoredExts`, dead-code
  does not (it recolors every file). **Alt name labels are NOT a base-sprite
  branch** — they attach as a sibling child of the root via `applyNodeLabelState`
  (the halo / worktree-ring pattern), drawn here only so labels survive a full
  rebuild that happens while Alt is held, and suppressed while a recolor overlay
  owns the sprite. Their *interactive* add/remove (depth scroll, Shift gate)
  goes through `labelSync`, never `graph.refresh()`.
- `sceneSetup.ts` — `configureCameraControls(graph)` locks `camera.up` and
  clamps OrbitControls polar to `[0, 0.75π]`. `createResizeObserver(graph, el)`
  installs the 150ms-debounced resize loop and returns a teardown.
- `GraphHud.tsx` / `GraphSelectionChip.tsx` / `GraphContextMenu.tsx` /
  `GraphTaskModal.tsx` — render-only overlays for the spinner+view chip+counts,
  the selection chip, the right-click popover, and the create-task modal. The
  HUD's bottom-left also hosts the search bar (`GraphSearchBar.tsx`) inline with
  the file/dir counts.
- `GraphSearchBar.tsx` + `searchMatcher.ts` + `hooks/useGraphSearch.ts` — the
  file search bar. `buildSearchRegExp` (searchMatcher) turns a query into a
  case-insensitive matcher: `*`/`?` wildcards by default, raw regex when the
  `.*` toggle is on. `useGraphSearch` runs two passes that both feed the shared
  `selected` set (so matches show the standard selection ring, one source of
  truth): a **filename pass** (pure, instant, client-side over `data.nodes`) and
  an opt-in **contents pass** (debounced, cancelable `GET /api/search`, gated on
  the file-icon toggle — name-only is the zero-cost default). The contents
  pass is a per-query snapshot — it does NOT re-run on file-content churn (the
  health watcher pushes a fresh `data` ref per save; re-greping each time would
  hammer the backend). `buildSearchRegExp` is kept byte-identical to the
  backend's (`backend/src/search.ts`) so a wildcard selects the same files in
  both passes. Search owns the selection while a query is active; clearing a
  search it drove restores empty, and an empty box never wipes a manual
  selection.
- `HealthTooltip.tsx` — measurement/composition wrapper for file health hover.
  Owns its own `pointermove` listener and writes directly to the element's
  `transform` so per-pixel cursor moves don't re-render the React tree;
  positioning lives in `tooltipPosition.ts`, metric row construction in
  `healthTooltipMetrics.ts`, and render-only sections in
  `HealthTooltipSections.tsx`. `cursorTracker.ts` caches the latest viewport
  cursor coords so the tooltip can render at the right place on mount.
- `idleController.ts` — reference-counted wrapper around the library's
  `pauseAnimation`/`resumeAnimation`. Pauses the RAF render loop when the
  d3 engine has settled, no overlay is animating, the user isn't
  interacting, or the tab is hidden. Attached to the graph instance so
  `clearLabelsAndRefresh` and the overlay hooks can reach it without
  threading another ref through the React tree. `isEngineHot()` exposes
  whether the layout is live this frame (consumers that cache per-frame
  geometry off node positions key on it). See the named-subsystems section.
  **Pauses are deferred to a microtask (load-bearing).** The library's
  `_animationCycle` re-schedules its own RAF unconditionally at the end of
  every frame, and `onEngineStop` fires *synchronously inside* that cycle (in
  `tickFrame`). A `pauseAnimation()` called straight from `engineStopped` only
  cancels the already-fired frame and is then overwritten by the cycle's
  trailing reschedule — so the loop would never actually stop after the layout
  settles (perpetual ~100% idle CPU). All pauses therefore route through a
  `queueMicrotask` so the cancel runs *between* frames, when the next-frame RAF
  is pending and genuinely cancellable. Resumes can stay synchronous
  (`resumeAnimation` is idempotent and only ever called between frames).
  **Frame-rate throttle:** when the only held reasons are the slow
  self-animations (`agents` / `labelPhysics`) and nothing demands full
  responsiveness (no `engine` / `interact` / `refresh`), the loop is
  duty-cycled to ~30fps via pause/resume — fed one frame at a time by
  `notifyFrameRendered` (wired to the scene frame driver in
  `useForceGraphInitialization`). Halves the full-scene render cost while an
  agent is active or a label overlay is held; warmup and interaction stay
  uncapped.
- `sceneFrameDriver.ts` — the single `scene.onBeforeRender` fan-out.
  `attachFrameDriver(graph)` (called once at init) installs the dispatcher;
  `onFrame(graph, cb)` subscribes a per-frame callback that runs at the head of
  every real render. Used by the APL (`useAgentOverlay`) and the label overlays
  (`labelRepulsionFrames`) so per-frame work runs only while the loop is already
  painting — no fragile chains of independently-mounted onBeforeRender wrappers.
- `sprites.ts` — `spriteFor(node, settings)`. Per-style `SpriteMaterial` cache so
  the simulation only allocates one material per (ext, shape, color) tuple.
- `labelTexture.ts` / `floatingLabelSprite.ts` / `metricOverlayFactory.ts` —
  shared canvas-label texture caches, camera-scaled label sprites, connector
  lines, and metric-overlay assembly used by LOC, health, and Alt labels.
- `locOverlay.ts` / `healthOverlay.ts` / `labelsOverlay.ts` — thin overlay
  configs + registries (`locLabelRegistry`, `healthLabelRegistry`,
  `labelsRegistry`) walked each frame for pairwise repulsion via
  `labelRepulsionFrames`. `labelsOverlay.applyNodeLabelState(root, node, …)` is
  the idempotent per-node toggle for an Alt name label: it adds/removes the
  label sprite + connector as sibling children of the node root (stashed on
  `root.userData`) and keeps `labelsRegistry` in lock-step — the halo pattern,
  applied to labels.
- `labelSync.ts` — `applyLabelsToGraph(graph, depths, settings, depth, shift,
  enabled, selectedIds)`: the in-place delta walker for the Alt overlay (mirrors
  `selectionHaloSync`). Walks the mounted nodes via the shared `mountedNodes`
  helpers and calls `applyNodeLabelState`, so changing the depth band or the Shift (file-label)
  gate toggles only the labels that changed — **no `graph.refresh()`**, which
  would dispose and rebuild every node sprite. `enabled` false (Alt released)
  passes a band no node occupies, stripping all labels. **Selection override:**
  when `selectedIds` is non-empty (and Alt held) the overlay shows the labels of
  exactly those nodes and no others — depth band + Shift gate ignored (see
  `shouldShowLabel` in `labelsOverlay`). Driven by `useLabelsOverlay`'s
  depth/Shift/mode/selection effect, which then wakes the idle controller so the
  change paints.
- `deadCodeOverlay.ts` — `spriteForDeadCode(node, settings)` for the `D`-hold
  overlay. A pure recolor (no label/connector, so no registry/RAF) keyed off
  `node.healthDetails.deadCode`: green=reachable, red=dead, grey=entry/uncertain
  (`DEAD_CODE_COLORS`). Reuses the shared `materialFor` cache.
- `labelRepulsion.ts` — named cleanup, world-snapshot, force accumulation,
  velocity/rest integration, and connector endpoint helpers behind
  `repelLabels(registry, minDist)`, which returns whether all labels have
  settled.
- `labelRepulsionFrames.ts` — `startLabelRepulsion(graph, registry, minDist)`:
  drives a label registry off the scene frame driver and holds the idle
  controller's `labelPhysics` reason ONLY while `repelLabels` reports motion,
  releasing it the frame the labels settle so the render loop idles even while
  the overlay key is held. `minDist` is a thunk (live `labelSpread`). Shared by
  all three repulsion overlays; replaced their old always-running per-hook RAFs.
- `halo.ts` — `setNodeHalo(root, on, baseSize)` adds/removes a light-blue
  ring as a sibling child of the node's root Group (drawn the same way as
  `changeRing.ts`). Designed for in-place toggling: a selection click
  walks only the affected ids and calls `setNodeHalo`, never
  `graph.refresh()`.
- `selectionHaloSync.ts` — `applySelectionHaloDelta(graph, prev, next,
  settings)` is the entry point for that in-place toggle. Looks up each
  affected sim node via the shared `mountedNodes` helpers and routes the call
  to `setNodeHalo`.
- `mountedNodes.ts` — the shared mounted-node helpers every overlay delta
  walker uses instead of re-deriving the same casts: `mountedNodes(graph)`
  (the live sim-node array), `mountedRoot(node)` (its `__threeObj` mounted root
  — three-forcegraph's default `objBindAttr`), `mountedNodesById(graph)` (an
  id→node index for selection deltas), and `baseSizeFor(node, settings)` (the
  ghost-aware ring/halo base size, the single source of truth shared with
  `nodeObjectFactory`). **Cache-free** — every call walks `graphData()` fresh so
  a structural swap can't serve a stale node. New ring/label overlays should
  reuse these rather than re-adding bespoke `__threeObj` casts or
  `graph.graphData().nodes` walkers.
- `changeRing.ts` — the timeline scrubber's git change rings, drawn as a
  sibling-child toggle on the node root (the halo pattern):
  `setNodeChangeRing(root, kind|null, baseSize)` adds/removes/recolors the
  ring (added=green, modified=yellow), `deletedSprite` renders a ghost
  (deleted-file) node from scratch (grey disc + red ring), and
  `setNodeChangeRingsVisible` is the `W`-overlay momentary hide. Materials are
  cached in `changeRingMaterials.ts` (4 GPU resources total).
- `changeRingSync.ts` — `applyChangeRingDelta(graph, prevMap, nextMap,
  settings, scanRoot)` is the scrub-driven in-place toggle (mirrors
  `selectionHaloSync`): it diffs the prev/next change maps and, for only the
  affected rel-paths, toggles each real file node's ring via `setNodeChangeRing`
  and flips affected ghost nodes' `.visible`. Used by `useGitTimeline` instead
  of `graph.refresh()`, so a scrubber notch is O(changed paths) ring mutations
  rather than an O(N) full sprite rebuild. The full-rebuild path
  (`buildNodeObject`) still attaches rings for genuine data/size/metric swaps.
- `claudeNodeSprite.ts` — `makeClaudeNode(color, size)`: the free-floating
  filled disc + soft glow drawn for each in-progress Claude agent.
  `makeSatelliteNode(color, size)`: the smaller hollow-ring sprite for a
  subagent satellite (same color as its parent). Materials cached per color.
- `agentOverlay.ts` — `AgentOverlay`, the drawing half of the **Agent Presence
  Layer** (see the named-subsystems section above for the APL ⇄ idle-controller
  render-on-demand contract). A `THREE.Group` added straight to
  `graph.scene()` (NOT via `graphData`, so an agent appearing/finishing
  never reheats the sim or distorts the DAG). Holds one Claude node per live
  agent plus focus beams (`THREE.Line`) to the files it touches. `tick()`
  returns whether the layer still has self-driven motion (drives the `agents`
  idle reason); rest is judged by distance-to-target within `REST_EPS`. The
  **last
  file an agent viewed/edited stays lit**: its beam never expires (`endAt =
  Infinity`) and its label stays up for the whole session — only *older*,
  no-longer-current files fade out on a TTL, and the whole node/label/beam set
  is cleared when the session stops (agent removed). Each node **hovers above
  the graph at a steady height**: `tick()` eases its X/Z toward the centroid of
  the files in play (so it sits over the region it's working in) while pinning
  Y to a low-pass-filtered hover line just above the graph's top, so the
  height stays stable as the layout settles. A camera-scaled **file label**
  sits beside each node showing the basename it most recently read/edited.
  Beams drop from the elevated node down to the file nodes. Path→node index
  rebuilt only on a structural `graphData` swap. Driven by `useAgentOverlay`.
  `agentOverlay.ts` is the orchestrator (reconcile/`addActivity`/`tick`); its
  cohesive internals are split into sibling modules:
  - `agentOverlayConstants.ts` — all overlay tunables + render orders
    (beam TTL/fade, easing, hover margins, golden angle, node/label scale +
    offsets, parked-spread radius) and `LABEL_OPTIONS` / `LABEL_SPRITE_CONFIG`.
  - `agentOverlayTypes.ts` — `SimNode` / `Beam` / `LabelHost` / `Satellite` /
    `Agent` / `AgentDescriptor` (the last re-exported from `agentOverlay.ts` as
    the public type). `Agent.satellites` holds the live subagent satellites.
  - `agentOverlayPathIndex.ts` — `normalizePath` / `baseName` plus
    `AgentPathIndex` (the path→node index lifecycle + `bounds()`/
    `centroidSpread()`) and the pure `hoverMargin(bounds)` clamp. `bounds()` (an
    O(N) scan) is memoised: invalidated on a structural swap and via
    `invalidateBounds()`, which `tick` calls on engine-hot frames + at least
    every `BOUNDS_RECHECK_FRAMES`, so it's recomputed only while nodes can move.
  - `agentOverlayBeams.ts` — beam `THREE.Line` lifecycle: `createBeam` /
    `createTether` (the persistent, dimmer parent→satellite line) /
    `disposeBeam` / `updateBeamEndpoints` (geometry only — used for tethers) /
    `updateBeam` (endpoints + opacity, with an `opacityFactor` to dim satellite
    beams) and the pure `beamFade(remaining)` ramp. The current-vs-fading TTL
    *policy* stays in `agentOverlay.applyActivity` (shared by the main agent and
    its satellites).
  - `agentOverlayLabels.ts` — file/type-label cache + `updateAgentLabel` /
    `clearAgentLabel` (agent file labels) + `updateSatelliteLabel` (satellite
    type labels), all over a shared `applyFloatingLabel` core (reusing
    `labelTexture` + `floatingLabelSprite`).
  - `agentOverlayPlacement.ts` — `parkedPosition` (golden-angle spiral),
    `satelliteOffset` (fixed ring slot around a parent) + `freeSatelliteSlot`,
    `lowPassStep`, and the `HoverLine` low-pass smoother for the hover height.
  The pure math (`hoverMargin`, `beamFade`, `parkedPosition`, `satelliteOffset`,
  `freeSatelliteSlot`, `lowPassStep`, `HoverLine`, `normalizePath`, `baseName`)
  is covered by `__tests__/agentOverlayMath.test.ts`.
- `worktreeRing.ts` — `setNodeWorktreeRing(root, on, color, baseSize)`: a
  double concentric ring (distinct from the single selection halo / change
  rings) colored by the owning task. Same sibling-child toggle as `halo.ts`;
  driven by the `W` overlay. Textures/materials cached per color.
- `menu.ts` — right-click `MENU_ITEMS` (Refactor/Add tests/Document/Find dead
  code) + `relPath(full, root)`.
- `graphSettings.ts` — `GraphSettings` shape, `DEFAULT_SETTINGS`,
  `loadSettings(project)`. Persisted under `lattice.graphSettings.<project>`.
  Physics-perf fields (added after the graph-perf investigation — see
  `plans/graph-perf-plan.md`): `chargeTheta` (Barnes-Hut accuracy for the n-body
  charge force; default 1.5 ≈ 3× cheaper than d3's 0.9, negligible visual
  change), `repulsionMode` (`'nbody'` | `'local'`; `'local'` swaps in the O(N)
  tree-aware `localRepulsionForce`), `linkWidth` (0 = flat lines instead of
  lit cylinders), and `batchedLinks` (render all links as one `LineSegments` —
  see `instancedLinks.ts`), and `batchedNodes` (render the base node shapes as a
  few instanced meshes — see `instancedNodes.ts`). The dominant per-*tick* layout
  CPU is `forceManyBody` (charge/repulsion fields target it); the dominant *orbit*
  CPU is N+E draw calls (`batchedLinks` targets the E half, `batchedNodes` the N
  half). The two are separate regimes.
- `localRepulsionForce.ts` — `forceLocalRepulsion()`: an O(N) linked-cell grid
  repulsion (X/Z plane only; cell size = interaction radius) that drop-in
  replaces d3's `forceManyBody` for the `charge` force when `repulsionMode ===
  'local'`. The file graph is a containment *tree*, so global Barnes-Hut n-body
  is overkill; this repels only same-cell + 8-neighbour nodes, mirroring the
  `labelPhysics/spatialGrid` integer-key + pooled-bucket pattern. Pure math,
  covered by `__tests__/localRepulsionForce.test.ts`.
- `instancedLinks.ts` — `createInstancedLinks(graph)`: batched link rendering for
  the `batchedLinks` setting. The library makes one `THREE.Line` per link (E
  draw calls/frame even at rest), so orbiting a settled graph re-submits ~N+E
  draw calls and spikes CPU. This collapses every visible link into **one
  `THREE.LineSegments`** in `graph.scene()`: it suppresses the library's per-link
  objects via `linkThreeObject(() => new Object3D())` (empty → no draw call;
  `tickFrame` skips geometry work for a non-Line/Mesh), reuses the library's
  installed `linkVisibility` accessor for the visible set, and re-uploads the
  position buffer **only on frames where node positions moved — keyed off the
  shared node-motion driver (`nodeMotionDriver.ts`) (+ a one-frame trailing sync
  for the settling frame)** — so a pure orbit is one static draw call, zero GPU
  uploads. The motion driver (not the idle controller's `isEngineHot()`) is the
  signal because a node *drag* reheats the engine internally without notifying the
  idle controller; and `onEngineTick` alone isn't enough either, because a drag
  AFTER the layout settles can't re-tick below `d3AlphaMin` — so the driver also
  listens to `onNodeDrag`. Flat lines read heavier than the
  lit cylinders they replace, so the configured link opacity is damped
  (`FLAT_LINE_OPACITY_SCALE`). Driven per-frame off the shared scene frame driver
  via `hooks/useBatchedLinks.ts`; rebuild (buffer resize) on a structural swap /
  hidden-ext change. Flat 1px lines (the `linkWidth: 0` look); opt-in while the
  look is evaluated. Low-risk because links carry no overlays and aren't pick
  targets. The node half is `instancedNodes.ts` (shipped).
- `instancedNodes.ts` — `createInstancedNodes(graph, opts)`: batched node
  rendering for the `batchedNodes` setting — the node half of the orbit-cost
  lever (links being the first half). The library mounts one Sprite-bearing
  `Group` per node (≈N draw calls/frame even at rest); this collapses the **base**
  node shapes into a few `THREE.InstancedMesh`es, one per distinct `styleKey`
  (≈5–50, = number of file types on screen). Each mesh reuses the EXACT cached
  sprite `CanvasTexture` (`materialFor(style).map`) drawn through a
  `MeshBasicMaterial` whose vertex shader is patched (one `<project_vertex>` swap)
  to billboard a unit quad in view space — so texture/color-management/flipY/uv
  orientation/world-sizing match the sprite with no atlas or colorspace guesswork
  (uv layout of `PlaneGeometry(1,1)` matches `THREE.Sprite`'s quad, preserving
  e.g. triangle apex). Per-instance position is re-uploaded only on node-motion
  frames (`nodeMotionDriver` + trailing settle), like batched links, so orbit is
  static. **Pick
  proxy:** the per-node sprite is NOT removed — `nodeObjectFactory` keeps it
  mounted but `.visible = false` (three.js raycasting ignores `.visible`: it
  tests only `object.layers`, and `Sprite.raycast` has no visibility guard), so
  the invisible sprite stays the hover/right-click pick target and the
  halo/change-ring/worktree-ring/Alt-label sibling children still anchor to it —
  this is what keeps picking + overlays untouched. **Overlays:** rather than
  mirror the health/loc/dead recolor precedence into per-instance colors, the
  mesh hides itself while any recolor overlay is active (`isBaseView()` false) and
  the per-node recolored sprite stays visible — those modes run on the proven
  per-node path. The mesh only ever draws the base (no-overlay) view, the
  orbit-cost steady state. Ghosts keep their per-node sprite (excluded here).
  Driven by `hooks/useInstancedNodes.ts`; rebuild (regroup + buffer resize) on a
  structural swap / hidden-ext change / node-size change. Opt-in while the look
  is evaluated.
- `nodeMotionDriver.ts` — single fan-out over three-forcegraph's one-slot
  node-motion callbacks (`onEngineTick` + `onNodeDrag` + `onNodeDragEnd`; mirrors
  `sceneFrameDriver` over `onBeforeRender`), so batched links AND batched nodes can
  both subscribe instead of fighting over the single setters.
  `attachNodeMotionDriver(graph)` at init installs the dispatchers;
  `onNodeMotion(graph, cb)` registers a listener and returns an unsubscribe.
  **Why all three signals:** `onEngineTick` fires only on frames the engine ticks;
  a drag rides those while warm, but once the layout SETTLES
  (`alpha < d3AlphaMin`) a drag's `resetCountdown()` can't make `layoutTick`
  re-tick (the `alpha < d3AlphaMin` stop branch trips before `layout.tick()` can
  raise alpha toward the drag's `alphaTarget(0.3)`), so `onEngineTick` never fires
  — but the drag handler still wrote the new `node.x` and fires `onNodeDrag`, which
  is the reliable "a node moved" signal during a settled-graph drag (the bug where
  dragged batched links/nodes froze once the physics settled). It is the
  position-sync signal, not the idle controller's `isEngineHot()` (which misses
  drags entirely). A second channel, `onNodeDragMove(graph, cb)` — `cb(node,
  translate, isEnd)` — carries the drag node + per-event delta (it owns the
  single `onNodeDrag`/`onNodeDragEnd` slots, so drag consumers register here);
  these run BEFORE the motion dispatch so their position mutations are in place
  when the batched sync reads them. Used by `useNodeDragBehavior`.
- `GraphSettingsPanel.tsx` — slider panel; pure UI, mutates the settings
  object via `onChange`.

## Hooks (`./hooks/`)

- `useForceGraphInitialization` — mounts ForceGraph3D once. Lifecycle wiring
  only; accessor closures delegate to `nodeObjectFactory` and the resize/camera
  setup lives in `sceneSetup`.
- `useGraphDataSync` — pushes ScanResult + ghost history into `graphData`,
  clears the label registries on each *structural* swap, resets selection.
  A new ScanResult ref that doesn't change the set of node ids and link
  endpoints (e.g. a single-file health update from the chokidar watcher)
  takes the **fast-patch path** instead: per-node `health`/`healthDetails`/
  `loc`/`size` fields are written onto the in-place sim nodes and
  `graph.refresh()` is called *only if an `H`/`Z`/`D` metric overlay is
  currently held* — those are the only views that render the patched fields, so
  with none held the refresh would rebuild all N sprites to a byte-identical
  result. That refresh-gating is critical for idle CPU: HealthUpdates stream
  constantly while the dev server writes files, and an unconditional refresh on
  each one wakes the render loop every time (`wakeForRefresh`), pinning it at
  ~100% on an otherwise-idle tab. The fields are still patched in place either
  way, so toggling an overlay on later picks up the latest values. The d3 force
  engine is *not* reheated, so the idle controller can keep the render loop
  paused. The full-swap path
  pins `engineStarted` for the duration of the new warmup and is now
  hard-bounded by `cooldownTicks: 400` + `cooldownTime: 8000` +
  `d3AlphaMin: 0.005` (set once in `useForceGraphInitialization`).
  **Two fast-patch tiers.** The common batched-metric update (from
  `scanResultPatch.patchUpdatedFiles`, fed by the metric-queue in
  `useProjectScan`) is caught by a *cheap* pre-check **before** any ghost
  rebuild or `shapeFingerprint`: same scan root, same `links` array identity
  (the patch helpers keep `prev.links` by reference; any structural change mints
  a new array), same node count, and unchanged `history` ref → patch metric
  fields in place, done. The sorted-`shapeFingerprint` tier is the fallback for
  full scans, ghost-history changes, removals, and same-shape rescans from fresh
  backend responses. Both tiers reuse one **cached id→sim-node index**
  (`nodeIndexRef`), rebuilt lazily and invalidated (set `null`) on every full
  `graph.graphData(...)` swap — the only thing that replaces the node array — so
  consecutive HealthUpdates don't rebuild the map per event. `buildForceGraphData`
  also stashes each file node's `relForward` under `REL_FORWARD_KEY` (see
  `timelineDiff.readRelForward`) when it mints fresh clones, so `buildNodeObject`
  reads the precomputed value instead of recomputing it per node per refresh.
- `useGraphTaskCreation` — modal action, prompt text, submitting + toast
  state, derived `selectedFiles`, plus `openMenuItem` / `submitTask` /
  `closeModal` actions.
- `useGraphOverlays` — composes `useGraphSettings` + `useGitTimeline` +
  `useLocOverlay` + `useHealthOverlay` + `useDeadCodeOverlay` +
  `useLabelsOverlay` + `useGraphFilter` so ForceGraphView gets one overlay
  setup point.
- `useHoldKeyMode` — the shared hold-key chord lifecycle behind every overlay
  (`H`/`Z`/`D`/`W`/Alt). Owns the four window/document listeners
  (keydown/keyup/blur/visibilitychange), the `isTextInput` keydown guard, the
  blur+tab-hide reset, and an opt-in `resetOnUnmount`; handlers are read through
  a ref so the listeners register once and never churn. `momentaryLetterMode(key,
  setActive, opts)` builds the handlers for a single-letter momentary chord
  (modifier-excluded, repeat-suppressed) — used by `H`/`Z`/`D`/`W`. Alt supplies
  bespoke handlers (modifier key + Shift sub-gate + `preventDefault`) to the same
  hook. New hold-key overlays should reuse this rather than re-adding listeners.
- `useDeadCodeOverlay` — the `D`-hold overlay. Hold-key chord via
  `useHoldKeyMode(momentaryLetterMode('d', …))` (blur + visibilitychange reset);
  recolors by reachability (`deadCode` field on each node's `healthDetails`). No
  labels/RAF — just a `clearLabelsAndRefresh` on toggle.
- `useAgentOverlay` — lifecycle half of the **Agent Presence Layer**, unified by
  the overlay's string agent id from two sources: in-progress `harness ===
  'claude'` tasks (task-colored node) and non-worktree Claude sessions from
  `/ws/agent-sessions` (orange `CLAUDE_ORANGE` node — push / workflow step /
  post-merge hook). Beams arrive as `task-activity` (taskId) and
  `agent-activity` (agentId) on `/ws/tasks`. Owns the `AgentOverlay` lifecycle.
  Drives `tick()` from `scene.onBeforeRender` (the graph's real render frames,
  not a private RAF) and holds the idle controller's `agents` reason **only
  while `tick()` reports motion** — `kick()` acquires to wake the loop on a
  change, the frame handler releases on rest. See the APL ⇄ idle-controller
  contract in the named-subsystems section.
- `useWorktreeHighlight` — the `W`-hold overlay. Hold-key chord via
  `useHoldKeyMode(momentaryLetterMode('w', …, { resetOnUnmount: true }))` (blur +
  visibilitychange reset; the only overlay that also strips its rings on
  unmount). On press, fetches `GET /api/tasks/worktree-modified` and rings each
  changed file in its task's color via `setNodeWorktreeRing` (walking the shared
  `mountedNodes`); strips them on release.
- `useBatchedLinks` — owns the `instancedLinks.ts` controller: creates it once
  after init (so the library's `linkVisibility` accessor is installed),
  subscribes its per-frame sync to the scene frame driver, toggles it on
  `settings.batchedLinks`, and rebuilds the batched geometry on a structural
  swap / hidden-ext change. Mounted after `useGraphDataSync` in `ForceGraphView`.
- `useInstancedNodes` — owns the `instancedNodes.ts` controller (the node
  analogue of `useBatchedLinks`): creates it once after init, subscribes its
  per-frame `onFrame` to the scene frame driver, toggles on `settings.batchedNodes`
  (a runtime toggle also fires `clearLabelsAndRefresh` so `nodeObjectFactory`
  flips the per-node base sprite's `.visible`), and rebuilds the instance buffers
  on a structural swap / hidden-ext / node-size change. Passes the controller a
  live `settingsRef` + an `isBaseView()` built from the health/loc/dead mode refs.
  Mounted after `useBatchedLinks`.
- `useNodeDragBehavior` — two drag-UX behaviors, registered via the motion
  driver's `onNodeDragMove` drag channel (always active, independent of the
  batched toggles): (1) **physics-active drag** — so a dragged node's children
  follow (link springs) and siblings make room (repulsion), the gesture lifts
  the settled-freeze by setting `d3AlphaMin(0)` for its duration, letting the
  library's own per-event `alphaTarget(0.3)` re-warm the sim (settled graphs
  otherwise re-trip the `alpha < d3AlphaMin` stop branch before a tick can raise
  alpha — so only the directly-pinned dragged node moved). Nodes at equilibrium
  barely move (near-zero net force) while neighbours visibly follow; `d3AlphaMin`
  is restored on drag end (library's `alphaTarget(0)` then cools it to rest), and
  `engineStarted()` holds the render loop through the warm-up + settle. (An
  earlier version rigidly block-translated the whole descendant subtree, which
  made dragging a top-level directory haul the entire graph; physics is what was
  wanted.) (2) **DAG-Y lock** — re-pins the dragged node's `fy`/`y` to its
  dragstart level (`__initialPos.y`), undoing the library's `fy = dragY` so a
  drag only slides within the node's horizontal plane; neighbours keep their own
  (deeper) `fy`, so the physics-follow moves them in X/Z only.
- `useNodeContextMenu` / `useBoxSelect` / `useRefMirror` /
  `refresh.ts` — small focused helpers consumed directly by the coordinator.
- `hooks/boxSelectGeometry.ts` — pure rectangle/projection hit-testing helpers
  for shift-drag selection; covered by node tests (no DOM/WebGL needed).
- `hooks/orbitControlLock.ts` — tiny disable/restore wrapper for OrbitControls
  rotate/pan flags during box-select gestures.

## Render-vs-physics splits

Three useEffects (inside the overlay sub-hooks) react to settings changes:
- Sizes (`fileNodeSize`/`dirNodeSize`/`labelSize`): clear the LOC, health, and
  Alt-label registries, then call `graph.refresh()` (re-evaluates
  `nodeThreeObject`, no sim restart). **Guarded** (`useGraphSettings`): the
  refresh is skipped on the initial mount and on any run where no nodes are
  mounted — `nodeThreeObject` reads `settingsRef.current` live, so the data-sync
  build already creates sprites at the current sizes; a refresh before then is a
  byte-identical rebuild that needlessly wakes the idle loop. A previous-size
  ref also no-ops a settings-object swap (e.g. project switch) that lands on
  identical sizes. Live slider drags still refresh (size changed + nodes
  mounted).
- Physics (`dagLevelDistance`/`charge`/`link`/`velocityDecay`/`chargeTheta`/
  `repulsionMode`): poke `d3Force` strengths + `d3ReheatSimulation()`. **The
  force pokes run on every run, including initial setup** — the graph is
  constructed only with `dagLevelDistance`, so a project's persisted non-default
  charge/link/decay must be pushed in here or they'd sit at the d3 defaults until
  the first slider drag. The **charge force is mode-selected** here:
  `chargeTheta` is applied to the n-body force, and `repulsionMode` swaps the
  `'charge'` force between the library's original `forceManyBody` (captured once
  into a ref so switching back restores it) and `forceLocalRepulsion` — only when
  the active force actually changes, so a settings tick doesn't needlessly
  re-init the force. **The reheat is guarded** (`useGraphSettings`): skipped on
  the initial mount (previous-value ref) and whenever no nodes are mounted (an
  empty sim has nothing to relax — the data-sync structural swap reheats once it
  populates `graphData`, picking up the forces we set). So a freshly-loaded/
  applied settings object no longer wakes the render loop for nothing; only an
  actual physics/DAG change on a populated graph reheats.
- Link width (`linkWidth`): render-only prop, its own guarded effect — calls
  `graph.linkWidth()` (rebuilds link objects) + `wakeForRefresh()` to paint;
  skipped on mount / empty graph (init already applies it). No reheat. Inert
  while `batchedLinks` is on (batched lines are always flat).
- Batched links (`batchedLinks`): not a settings *effect* — `useBatchedLinks`
  owns it. Toggling on swaps `linkThreeObject` for empty objects + draws one
  `LineSegments`; off restores the default per-link lines. No reheat; the
  per-frame position sync rides the scene frame driver and only uploads while
  the engine is hot.
- Batched nodes (`batchedNodes`): not a settings *effect* — `useInstancedNodes`
  owns it. Toggling on draws the base shapes as a few InstancedMeshes and
  (via `nodeObjectFactory` + a refresh) makes the per-node base sprites invisible
  pick proxies; off disposes the meshes and re-shows the sprites. No reheat; the
  per-frame position sync rides the scene frame driver + engine-tick driver. A
  recolor overlay (`h`/`z`/`d`) being held hides the meshes and the per-node
  recolored sprites take over.
- Filter (`hiddenExts`): swap `nodeVisibility`/`linkVisibility` accessors.
  No restart. (When batched, `useBatchedLinks` also rebuilds off this so the
  LineSegments tracks the same visible set.)

## Render-path perf invariants (read before touching overlay/beam/label hot paths)

Pure CPU/allocation optimizations on the graph render path; each is *visually
identical* to what it replaced. Preserve these invariants when editing the
files below.

- **Structure-only consumers key off `useStructuralScan(data)`, not `data`.**
  `data` gets a fresh reference on every metric-only HealthUpdate (one per file
  save). `useStructuralScan` (`frontend/src/hooks/useStructuralScan.ts`) returns
  a reference that changes only when the file *structure* does — it keys a memo
  on `data.links` identity, which the `scanResultPatch` helpers preserve across
  metric patches and rebuild on any structural change. Consumers that read only
  structural fields (file/dir counts in `ForceGraphView`, `legend/useLegendRows`,
  the filename pass in `useGraphSearch`, workflow stack detection in
  `useWorkflowManager`) depend on it so they skip the O(N) recompute + re-render
  per save. **INVARIANT: only feed the structural reference to consumers that
  never read metric fields (health/loc/size) — it carries stale metrics by
  design.** Add/remove/rename and hidden-ext changes still update immediately
  (new links array → new reference; `hiddenExts` is a separate dep).
- **Shared, module-owned label/connector resources (caching invariant).**
  Toggling an `H`/`Z`/Alt overlay calls `graph.refresh()`, which rebuilds every
  node object. The immutable Three.js pieces are cached at module scope so a
  refresh over hundreds/thousands of files no longer allocates per node:
  `floatingLabelSprite.ts` caches the floating-label `SpriteMaterial` by its
  texture (WeakMap — the material depends only on the texture map), the
  connector `LineBasicMaterial` by `(color, opacity)`, `THREE.Color` by hex, and
  a connector-geometry **template** by its constant endpoints; `metricOverlay
  Factory.ts` shares ONE label-texture cache across the health + LOC overlays
  (identical number glyphs aren't duplicated). **INVARIANT: anything cached here
  is module-owned and must NEVER be disposed per-node.** Each connector line
  gets its OWN `clone()` of the geometry template (the repulsion step mutates its
  upper endpoint per-frame, so it can't be one shared instance) — that clone is
  the *only* thing a per-node teardown owns, so `labelsOverlay.disposeLabelEntry`
  frees the cloned geometry and nothing else (never the shared materials/
  textures). Same rule for agent labels (`agentOverlayLabels.ts`) — their
  textures/materials come from the same caches.
- **Skip redundant per-frame work in the APL (beams/labels/nodes).**
  `agentOverlayBeams.updateBeam` re-uploads beam geometry to the GPU only when an
  endpoint moved beyond `BEAM_MOVE_EPS` (caching the last endpoints on the beam),
  so a persistent beam over stationary nodes stops re-uploading identical
  geometry every frame — but the opacity/fade update still runs every frame so
  fading beams ramp out correctly. In `AgentOverlay.tick`, the node easing +
  `node.position.copy` run only while the node is still > `REST_EPS` from target
  (the same criterion that drives the `agents` idle reason; the < `REST_EPS`
  residual is sub-pixel), each beam's file node is resolved ONCE in the centroid
  pass and stashed on `beam.targetNode` for reuse in the geometry pass (one
  `pathIndex.get` per beam, not two), and `updateAgentLabel` skips its
  `position.set` when `agent.pos` + `nodeSize` are unchanged since last call. Do
  not reintroduce a per-frame node/label/beam write that runs while everything is
  at rest — it defeats render-on-demand even though the loop is duty-cycled.
- **Floating-label scale recompute is memoised.** Each floating-label sprite's
  `onBeforeRender` early-returns from the camera-distance scale recompute (the
  `getWorldPosition`-distance-`sqrt`-`scale.set`) when neither the camera nor the
  sprite's world position moved beyond `SCALE_RECOMPUTE_EPS` since the last
  frame. The scale is a pure function of distance, so an unchanged distance gives
  an identical scale.
- **Label-physics spatial grid uses an integer cell key.** `labelPhysics/
  spatialGrid.ts` keys `cellGrid` by a packed integer
  `(cx + BIAS) * STRIDE + (cz + BIAS)` instead of a `"cx,cz"` string, so the
  hottest per-frame loop (`repelLabels`, every frame while a label/`H`/`Z`
  overlay is held and labels move) allocates no per-cell key strings. **The key
  is an opaque per-cell bucket identity** — a pure representation change, same
  neighbour set, same forces. `BIAS = 2e6` / `STRIDE = 4e6` are collision-free
  for any cell coordinate in `[-2e6, 2e6)` (key max ≈ 1.6e13 ≪
  `Number.MAX_SAFE_INTEGER`); real graphs stay within a few thousand cells. The
  build pass also stashes each label's integer `(cx, cz)` into the reusable
  `cellX`/`cellZ` scratch `Int32Array`s (grown in lockstep by `ensureCapacity`)
  and the pairwise pass reuses them instead of recomputing the floor/divide. The
  grid is rebuilt from scratch each frame (no cross-frame state); the
  `labelRepulsion` tests assert on force results, not key form, so they stay
  green.

## Camera

`up = (0,1,0)`; polar clamped to `[0, 0.75π]`. OrbitControls (not Trackball).
`dagMode='td'`. Configured in `sceneSetup.configureCameraControls`.
