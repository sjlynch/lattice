# frontend/src

Vite + React + TS. This file is the authoritative frontend navigation doc
(the package `README.md` is mostly the stock Vite template). Hand-written CSS —
`index.css` is an ordered `@import` list, with feature-scoped stylesheets in
`styles/` (see `components/CLAUDE.md` for the style map). No MUI, no
styled-components.

## Layout

- `main.tsx` — React entry: `createRoot` → top-level `ErrorBoundary` → `App`, in `StrictMode`.
- `App.tsx` — top-level shell: TopAppBar + resizable Sidebar + ForceGraphView + Legend, wrapped in `ConfirmProvider` + `TerminalsProvider` (the graph subtree gets its own `ErrorBoundary`). Project-scoped state is split across `hooks/` (`useActiveFolder`, `useProjectScan`/`useStructuralScan`, `useHiddenExtensions`, `useSidebarWidth`, `useStartupTerminalSync`). `useUserSettings(activeFolder)` does the single per-folder `userSettings.json` fetch; `useSidebarWidth` / `useStartupTerminalSync` / `useMetricsIgnoredExts` (and App's terminal-launch defaults) read their slice from it instead of each fetching. App itself is layout + wiring.
- `api/` — every backend call. Domain-grouped (`tasks.ts`, `mergeRuns.ts`, `workflows.ts`, `scan.ts`, `settings.ts`, `mcp.ts`, `health.ts`, `pushRuns.ts`, `qaRuns.ts`, `postMergeHooks.ts`, `globalSettings.ts`). Generic WS subscriber in `ws.ts`, shared HTTP helpers in `http.ts`, shared types in `types/`. Components import from `'../api'` which resolves to `api/index.ts`. See `api/CLAUDE.md`.
- `components/` — UI. Big launchers live in subdirectories with shim re-exports at the top level (`TaskBoard.tsx` → `taskboard/`, `Workflows.tsx` → `workflows/`, `ForceGraphView.tsx` → `forceGraph/`).
- `hooks/` — project-scoped React hooks (the ones App wires, plus `useHarnessAvailability`, `usePiModelMenu`, `useDismissOnOutside`, `useFocusTrap`, …) and non-hook helpers (scan schedulers/retry/patch/snapshot, `hiddenExtsPersist`, `resolveDefaultRoot`). See `hooks/CLAUDE.md`.
- `TerminalsContext.tsx` — global terminal-tab state, persisted to sessionStorage (per-tab). `addTerminal({...})` is how features spawn agent sessions. Reducer/storage/IO helpers live in `terminal/` (see `terminal/CLAUDE.md`); the context file is just React glue around them.
- `extensionStyles.ts` — single source of truth for sprite shape/color per file extension. Shared by graph + Legend.
- `taskColors.ts` — single source of truth for per-task accent colors (taskboard card stripe, graph Claude node, `W` worktree rings): a golden-angle hue walk over the backend-assigned `colorIndex` slot (`taskColor`), with an id-hash fallback for slotless tasks. `CLAUDE_ORANGE` is the fixed color for non-task Claude sessions.
- `appConfig.ts` — `APP_CONFIG` constants (storage-key prefixes, sidebar sizing, scan-retry backoff).
- `projectPath.ts` — `canonicalProjectPath`: uppercases the Windows drive letter so per-project keys line up; mirrors backend `projectPath.ts`.
- `storage/latticeLocalStorage.ts` — safe localStorage get/set/remove + the `lattice.graph*.<project>` key builders.
- `utils/terminalMap.ts` — `buildTerminalMap` (taskId → terminalId lookup for task-board focus buttons).
- `workflowTemplates.ts` — built-in templates surfaced in the Workflows picker.
- `harnesses.ts` — shared frontend vocabulary/helpers for agent harness strings, labels, and availability-filtered option lists. Also the Pi-model dropdown encoding: `buildHarnessOptions` (flattens harness + curated Pi models into "Pi — X" rows) and `encodeHarnessValue`/`decodeHarnessValue` (the `pi:<provider/model>` `<select>` value ⇄ `{harness, piModel}`).
- `piMenuStoreCore.ts` / `piModelMenuStore.ts` — shared cache + refresh signal for the curated "Pi — X" model menu. `piMenuStoreCore` is the pure `createPiMenuStore(fetcher)` factory (unit-tested); `piModelMenuStore` builds the `getPiModels`-backed singleton + `notifyPiModelsChanged()`. Consumed via `hooks/usePiModelMenu`; alongside `hooks/useHarnessAvailability`, this is the one source of harness/Pi-menu data shared by the task board, workflow steps/overrides, post-merge hook, and sidebar new-terminal dropdowns.

## Per-project state keys

- `localStorage`: `lattice.hiddenExts.<path>`, `lattice.graphSettings.<path>`, `lattice.graphSettingsTab.<path>`, `lattice.graphCamera.<path>` (saved camera position + orbit target, restored on refresh/project switch), `lattice.<panel>.window`.
- `sessionStorage`: `lattice.activeFolder`, `lattice.terminals` (both per-tab so multiple tabs each track their own project + terminal list independently).
- Backend: `<project>/.lattice/userSettings.json` (sidebar width, harness).

## Type-check & tests

- Type-check: `npx tsc -b` from `frontend/`. The 3d-force-graph TS warning is pre-existing — vite still runs.
- Tests: `npm test` from `frontend/` (node:test via `tsx` over `__tests__/*.test.ts` — pure-logic units for schedulers, geometry, persistence, project-switch scoping, etc.). See `__tests__/CLAUDE.md`.
