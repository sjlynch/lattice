# forceGraph

3D file-tree view. `ForceGraphView.tsx` (parent dir) is a re-export shim.

## Modules

- `ForceGraphView.tsx` — coordinator. Holds `selected`/`hoverNode`/`showSettings`,
  threads refs through `useGraphOverlays` + `useForceGraphInitialization`, and
  composes the small `Graph*` overlay components below. Each remaining
  `useEffect` is one concern: selection-refresh, Escape key, counts memo.
- `nodeObjectFactory.ts` — `buildNodeObject(node, refs)` + `nativeNodeLabel(node)`.
  The decision tree for ghost vs health vs LOC vs dead-code vs labels vs base
  sprite (+ change-ring and selection-halo wrap order) lives here; the init hook
  just hands the closure to `ForceGraph3D.nodeThreeObject`. Precedence is
  health > loc > dead > labels; health/loc skip `metricsIgnoredExts`, dead-code
  does not (it recolors every file).
- `sceneSetup.ts` — `configureCameraControls(graph)` locks `camera.up` and
  clamps OrbitControls polar to `[0, 0.75π]`. `createResizeObserver(graph, el)`
  installs the 150ms-debounced resize loop and returns a teardown.
- `GraphHud.tsx` / `GraphSelectionChip.tsx` / `GraphContextMenu.tsx` /
  `GraphTaskModal.tsx` — render-only overlays for the spinner+view chip+counts,
  the selection chip, the right-click popover, and the create-task modal.
- `HealthTooltip.tsx` — measurement/composition wrapper for file health hover.
  Owns its own `pointermove` listener and writes directly to the element's
  `transform` so per-pixel cursor moves don't re-render the React tree;
  positioning lives in `tooltipPosition.ts`, metric row construction in
  `healthTooltipMetrics.ts`, and render-only sections in
  `HealthTooltipSections.tsx`. `cursorTracker.ts` caches the latest viewport
  cursor coords so the tooltip can render at the right place on mount.
- `idleController.ts` — reference-counted wrapper around the library's
  `pauseAnimation`/`resumeAnimation`. Pauses the RAF render loop when the
  d3 engine has settled, no overlay RAF is active, the user isn't
  interacting, or the tab is hidden. Attached to the graph instance so
  `clearLabelsAndRefresh` and the overlay hooks can reach it without
  threading another ref through the React tree.
- `sprites.ts` — `spriteFor(node, settings)`. Per-style `SpriteMaterial` cache so
  the simulation only allocates one material per (ext, shape, color) tuple.
- `labelTexture.ts` / `floatingLabelSprite.ts` / `metricOverlayFactory.ts` —
  shared canvas-label texture caches, camera-scaled label sprites, connector
  lines, and metric-overlay assembly used by LOC, health, and Alt labels.
- `locOverlay.ts` / `healthOverlay.ts` / `labelsOverlay.ts` — thin overlay
  configs + registries (`locLabelRegistry`, `healthLabelRegistry`,
  `labelsRegistry`) walked by the RAF loop for pairwise repulsion.
- `deadCodeOverlay.ts` — `spriteForDeadCode(node, settings)` for the `D`-hold
  overlay. A pure recolor (no label/connector, so no registry/RAF) keyed off
  `node.healthDetails.deadCode`: green=reachable, red=dead, grey=entry/uncertain
  (`DEAD_CODE_COLORS`). Reuses the shared `materialFor` cache.
- `labelRepulsion.ts` — named cleanup, world-snapshot, force accumulation,
  velocity/rest integration, and connector endpoint helpers behind
  `repelLabels(registry, minDist)`.
- `halo.ts` — `setNodeHalo(root, on, baseSize)` adds/removes a light-blue
  ring as a sibling child of the node's root Group (drawn the same way as
  `changeRing.ts`). Designed for in-place toggling: a selection click
  walks only the affected ids and calls `setNodeHalo`, never
  `graph.refresh()`.
- `selectionHaloSync.ts` — `applySelectionHaloDelta(graph, prev, next,
  settings)` is the entry point for that in-place toggle. Reads each
  affected sim node's `__threeObj` (three-forcegraph's default
  `objBindAttr`) and routes the call to `setNodeHalo`.
- `claudeNodeSprite.ts` — `makeClaudeNode(color, size)`: the free-floating
  filled disc + soft glow drawn for each in-progress Claude agent. Material
  cached per color.
- `agentOverlay.ts` — `AgentOverlay`: a `THREE.Group` added straight to
  `graph.scene()` (NOT via `graphData`, so an agent appearing/finishing
  never reheats the sim or distorts the DAG). Holds one Claude node per live
  agent plus focus beams (`THREE.Line`) to the files it touches. The **last
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
  - `agentOverlayTypes.ts` — `SimNode` / `Beam` / `Agent` / `AgentDescriptor`
    (the latter still re-exported from `agentOverlay.ts` as the public type).
  - `agentOverlayPathIndex.ts` — `normalizePath` / `baseName` plus
    `AgentPathIndex` (the path→node index lifecycle + `bounds()`/
    `centroidSpread()`) and the pure `hoverMargin(bounds)` clamp.
  - `agentOverlayBeams.ts` — beam `THREE.Line` lifecycle: `createBeam` /
    `disposeBeam` / `updateBeam` (endpoints + opacity) and the pure
    `beamFade(remaining)` ramp. The current-vs-fading TTL *policy* stays in
    `agentOverlay.addActivity`.
  - `agentOverlayLabels.ts` — agent file-label cache + `updateAgentLabel` /
    `clearAgentLabel` (reusing `labelTexture` + `floatingLabelSprite`).
  - `agentOverlayPlacement.ts` — `parkedPosition` (golden-angle spiral),
    `lowPassStep`, and the `HoverLine` low-pass smoother for the hover height.
  The pure math (`hoverMargin`, `beamFade`, `parkedPosition`, `lowPassStep`,
  `HoverLine`, `normalizePath`, `baseName`) is covered by
  `__tests__/agentOverlayMath.test.ts`.
- `worktreeRing.ts` — `setNodeWorktreeRing(root, on, color, baseSize)`: a
  double concentric ring (distinct from the single selection halo / change
  rings) colored by the owning task. Same sibling-child toggle as `halo.ts`;
  driven by the `W` overlay. Textures/materials cached per color.
- `menu.ts` — right-click `MENU_ITEMS` (Refactor/Add tests/Document/Find dead
  code) + `relPath(full, root)`.
- `graphSettings.ts` — `GraphSettings` shape, `DEFAULT_SETTINGS`,
  `loadSettings(project)`. Persisted under `lattice.graphSettings.<project>`.
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
  `graph.refresh()` is called. The d3 force engine is *not* reheated, so
  the idle controller can keep the render loop paused. The full-swap path
  pins `engineStarted` for the duration of the new warmup and is now
  hard-bounded by `cooldownTicks: 400` + `cooldownTime: 8000` +
  `d3AlphaMin: 0.005` (set once in `useForceGraphInitialization`).
- `useGraphTaskCreation` — modal action, prompt text, submitting + toast
  state, derived `selectedFiles`, plus `openMenuItem` / `submitTask` /
  `closeModal` actions.
- `useGraphOverlays` — composes `useGraphSettings` + `useGitTimeline` +
  `useLocOverlay` + `useHealthOverlay` + `useDeadCodeOverlay` +
  `useLabelsOverlay` + `useGraphFilter` so ForceGraphView gets one overlay
  setup point.
- `useDeadCodeOverlay` — the `D`-hold overlay. Same keydown/keyup chord pattern
  as `h`/`z`/`w` (blur + visibilitychange reset); recolors by reachability
  (`deadCode` field on each node's `healthDetails`). No labels/RAF — just a
  `clearLabelsAndRefresh` on toggle.
- `useAgentOverlay` — owns the Claude-agent overlay, unified by the overlay's
  string agent id from two sources: in-progress `harness === 'claude'` tasks
  (task-colored node) and non-worktree Claude sessions from
  `/ws/agent-sessions` (orange `CLAUDE_ORANGE` node — push / workflow step /
  post-merge hook). Beams arrive as `task-activity` (taskId) and
  `agent-activity` (agentId) on `/ws/tasks`. Owns the `AgentOverlay`
  lifecycle and the RAF; holds the idle controller's `agents` reason while
  anything is on screen, releases it when none remain.
- `useWorktreeHighlight` — the `W`-hold overlay. Same keydown/keyup chord
  pattern as `h`/`z` (blur + visibilitychange reset). On press, fetches
  `GET /api/tasks/worktree-modified` and rings each changed file in its
  task's color via `setNodeWorktreeRing`; strips them on release.
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
  `nodeThreeObject`, no sim restart).
- Physics (`dagLevelDistance`/`charge`/`link`/`velocityDecay`): poke
  `d3Force` strengths + `d3ReheatSimulation()`.
- Filter (`hiddenExts`): swap `nodeVisibility`/`linkVisibility` accessors.
  No restart.

## Camera

`up = (0,1,0)`; polar clamped to `[0, 0.75π]`. OrbitControls (not Trackball).
`dagMode='td'`. Configured in `sceneSetup.configureCameraControls`.
