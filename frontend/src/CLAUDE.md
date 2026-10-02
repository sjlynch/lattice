# frontend/src

Vite + React + TS. This file is the authoritative frontend navigation doc
(the package [README.md](../README.md) is a brief Lattice UI overview). Hand-written CSS —
`index.css` is an ordered `@import` list, with feature-scoped stylesheets in
`styles/` (see `components/CLAUDE.md` for the style map). No MUI, no
styled-components.

## Layout

- `main.tsx` — React entry: `createRoot` → top-level `ErrorBoundary` → `App`, in `StrictMode`.
- `App.tsx` — top-level shell: TopAppBar + resizable Sidebar + ForceGraphView + Legend, wrapped in `ConfirmProvider` + `GitSetupProvider` + `TerminalsProvider` (the graph subtree gets its own `ErrorBoundary`). Project-scoped state is split across `hooks/` (`useActiveFolder`, `useProjectScan`/`useStructuralScan`, `useHiddenExtensions`, `useSidebarWidth`, `useStartupTerminalSync`). `useUserSettings(activeFolder)` does the single per-folder `userSettings.json` fetch; `useSidebarWidth` / `useStartupTerminalSync` / `useMetricsIgnoredExts` (and App's terminal-launch defaults) read their slice from it instead of each fetching. App itself is layout + wiring.
- `api/` — every backend call. Domain-grouped (`tasks.ts`, `mergeRuns.ts`, `workflows.ts`, `scan.ts`, `settings.ts`, `mcp.ts`, `health.ts`, `pushRuns.ts`, `qaRuns.ts`, `postMergeHooks.ts`, `globalSettings.ts`). WebSocket transport (`ws.ts` is now only a compatibility re-export): `wsTransport.ts` owns `subscribeWs`, reconnect backoff and `WS_STABLE_MS`; `wsSharedChannels.ts` owns shared subscriptions and their last-message replay cache, released on the final unsubscribe; `wsConnectionHealth.ts` owns the backend-down signal. Shared HTTP helpers in `http.ts`, shared types in `types/`. Components import from `'../api'` which resolves to `api/index.ts`. See `api/CLAUDE.md`.
- `components/` — UI. Big launchers live in subdirectories with shim re-exports at the top level (`TaskBoard.tsx` → `taskboard/`, `Workflows.tsx` → `workflows/`, `ForceGraphView.tsx` → `forceGraph/`).
- `hooks/` — project-scoped React hooks (the ones App wires, plus `useHarnessAvailability`, `usePiModelMenu`, `useDismissOnOutside`, `useFocusTrap`, …) and non-hook helpers (scan schedulers/retry/patch/snapshot, `hiddenExtsPersist`, `resolveDefaultRoot`). See `hooks/CLAUDE.md`.
- `TerminalsContext.tsx` — global terminal-tab state. `addTerminal({...})` is how features spawn agent sessions (pass the backend's `terminalId` as `id` so the tab is the registry's). Takes `activeFolder` + `restoreMode` from App: on project open it fetches the durable registry (`/api/terminal-tabs`), subscribes to `/ws/terminal-tabs`, and — per `restoreTerminalsOnOpen` — asks the backend to restore (re-attach / relaunch) the tabs; label / order edits are PATCHed back, a registered tab closes through the registry. sessionStorage is now only a paint-before-fetch cache. Reducer/storage/IO helpers live in `terminal/` (see `terminal/CLAUDE.md`); the context file is just React glue around them.
- `extensionStyles.ts` — single source of truth for sprite shape/color per file extension. Shared by graph + Legend.
- `taskColors.ts` — single source of truth for per-task accent colors (taskboard card stripe, graph Claude node, `W` worktree rings): a golden-angle hue walk over the backend-assigned `colorIndex` slot (`taskColor`), with an id-hash fallback for slotless tasks. `CLAUDE_ORANGE` is the fixed color for non-task Claude sessions.
- `appConfig.ts` — `APP_CONFIG` constants (storage-key prefixes, sidebar sizing, scan-retry backoff).
- `projectPath.ts` — `canonicalProjectPath` only uppercases the Windows drive
  letter; it leaves directory casing and separators unchanged and cannot resolve
  symlinks. The backend resolves native realpaths and preserves legacy storage
  bindings, so never hash a frontend path to locate backend state. Compare
  backend-stamped paths with `activeFolder` through
  `terminal/terminalScope.ts`'s `normalizeDirPath` (or `sameProjectPath`), not `===`.
- `storage/latticeLocalStorage.ts` — safe localStorage get/set/remove + the `lattice.graph*.<project>` key builders.
- `utils/terminalMap.ts` — `buildTerminalMap` (taskId → terminalId lookup for task-board focus buttons).
- `workflowTemplates.ts` — built-in templates surfaced in the Workflows picker.
  Two rules: (1) every agent step **files tasks** — never write a template step
  that implements or commits, since `WORKFLOW_STEP.md` forbids it and that
  contradiction is what let a step commit code directly (see
  `backend/src/workflows/defaultPromptMigrations.ts`); (2) a template is a pure
  chain of agent steps, i.e. what a user gets from clicking quick-add chips in a
  row — **don't bundle `start`/`merge`/`push` control steps into one.** Landing
  work stays an explicit action the user adds. `plan-build-ship` is the single
  deliberate exception: driving the board to a push is its entire purpose and
  its name says so. A template step may carry `tools` (e.g.
  `security-review-opengrep` sets `tools: ['opengrep']`, importing the same
  `prompts/opengrep.md` body as the "Opengrep" quick-add chip) so the backend
  runs that pre-run tool before the step's harness spawns; the row shows a
  read-only shield badge, and `newFromTemplate` spreads the step so the field
  survives. There is no per-step toggle on purpose: the scan belongs to the
  Opengrep step.
- `harnesses.ts` — shared frontend vocabulary/helpers for agent harness strings, labels, and availability-filtered option lists. Also the Pi-model dropdown encoding: `buildHarnessOptions` (flattens harness + curated Pi models into "Pi — X" rows) and `encodeHarnessValue`/`decodeHarnessValue` (the `pi:<provider/model>` `<select>` value ⇄ `{harness, piModel}`).
- `piMenuStoreCore.ts` / `piModelMenuStore.ts` — shared cache + refresh signal for the curated "Pi — X" model menu. `piMenuStoreCore` is the pure `createPiMenuStore(fetcher)` factory (unit-tested); `piModelMenuStore` builds the `getPiModels`-backed singleton + `notifyPiModelsChanged()`. Consumed via `hooks/usePiModelMenu`; alongside `hooks/useHarnessAvailability`, this is the one source of harness/Pi-menu data shared by the task board, workflow steps/overrides, post-merge hook, and sidebar new-terminal dropdowns.

## Per-project state keys

- `localStorage`: `lattice.hiddenExts.<path>`, `lattice.graphSettings.<path>`, `lattice.graphSettingsTab.<path>`, `lattice.graphCamera.<path>` (saved camera position + orbit target, restored on refresh/project switch), `lattice.laneSort.<path>`, `lattice.workflowEditorDraft.<path>`, `lattice.<panel>.window`, and the global `lattice.legend.open` / `lattice.legend.all` (feature docs own the detail).
- `sessionStorage`: `lattice.activeFolder`, `lattice.terminals` (both per-tab so multiple tabs each track their own project + terminal list independently).
- Backend: `<project>/.lattice/userSettings.json` (sidebar width, harness).

## Build, type-check & tests

Commands below use `frontend/` as the working directory:

- Build: `npm run build` — TypeScript build plus Vite bundle.
- Type-check: `npx tsc -b`.
- Tests: `npm test` — node:test via `tsx` over `src/__tests__/*.test.ts` (pure-logic units for schedulers, geometry, persistence, project-switch scoping, etc.). See `__tests__/CLAUDE.md`.
