# forceGraph

3D file-tree view. `ForceGraphView.tsx` (parent dir) is a re-export shim.

## Modules

- `ForceGraphView.tsx` — coordinator. Holds `selected`/`hoverNode`/`showSettings`,
  threads refs through `useGraphOverlays` + `useForceGraphInitialization`, and
  composes the small `Graph*` overlay components below. Each remaining
  `useEffect` is one concern: selection-refresh, Escape key, counts memo.
- `nodeObjectFactory.ts` — `buildNodeObject(node, refs)` + `nativeNodeLabel(node)`.
  The decision tree for ghost vs health vs LOC vs labels vs base sprite (+
  change-ring and selection-halo wrap order) lives here; the init hook just
  hands the closure to `ForceGraph3D.nodeThreeObject`.
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
- `labelRepulsion.ts` — named cleanup, world-snapshot, force accumulation,
  velocity/rest integration, and connector endpoint helpers behind
  `repelLabels(registry, minDist)`.
- `halo.ts` — `withHalo(child, baseSize)` wraps a sprite in a thin light-blue
  ring for the selection state (drawn the same way as `changeRing.ts`).
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
  clears the label registries on each swap, resets selection.
- `useGraphTaskCreation` — modal action, prompt text, submitting + toast
  state, derived `selectedFiles`, plus `openMenuItem` / `submitTask` /
  `closeModal` actions.
- `useGraphOverlays` — composes `useGraphSettings` + `useGitTimeline` +
  `useLocOverlay` + `useHealthOverlay` + `useLabelsOverlay` +
  `useGraphFilter` so ForceGraphView gets one overlay setup point.
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
