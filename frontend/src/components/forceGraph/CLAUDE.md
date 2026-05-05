# forceGraph

3D file-tree view. `ForceGraphView.tsx` (parent dir) is a re-export shim.

## Modules

- `ForceGraphView.tsx` — main component. Each concern is a separate `useEffect`: mount/teardown, data swap, LOC key, sprite refresh, physics reheat, label repulsion RAF loop, ext filter, box-select drag, ctx-menu close, toast.
- `sprites.ts` — `spriteFor(node, settings)`. Per-style `SpriteMaterial` cache so the simulation only allocates one material per (ext, shape, color) tuple.
- `locOverlay.ts` — LOC overlay sprites + `locLabelRegistry` (RAF loop in ForceGraphView walks this for pairwise repulsion).
- `halo.ts` — `withHalo(child, baseSize)` wraps a sprite in a thin light-blue ring for the selection state (drawn the same way as `changeRing.ts`).
- `menu.ts` — right-click `MENU_ITEMS` (Refactor/Add tests/Document/Find dead code) + `relPath(full, root)`.
- `graphSettings.ts` — `GraphSettings` shape, `DEFAULT_SETTINGS`, `loadSettings(project)`. Persisted under `lattice.graphSettings.<project>`.
- `GraphSettingsPanel.tsx` — slider panel; pure UI, mutates the settings object via `onChange`.

## Render-vs-physics splits

Three useEffects react to settings changes:
- Sizes (`fileNodeSize`/`dirNodeSize`/`labelSize`): clear `locLabelRegistry`, call `graph.refresh()` (re-evaluates `nodeThreeObject`, no sim restart).
- Physics (`dagLevelDistance`/`charge`/`link`/`velocityDecay`): poke `d3Force` strengths + `d3ReheatSimulation()`.
- Filter (`hiddenExts`): swap `nodeVisibility`/`linkVisibility` accessors. No restart.

## Camera

`up = (0,1,0)`; polar clamped to `[0, 0.75π]`. OrbitControls (not Trackball). `dagMode='td'`.
