# frontend/src

Vite + React + TS. Hand-written CSS — `index.css` is an ordered `@import`
list, with feature-scoped stylesheets in `styles/` (see
`components/CLAUDE.md` for the style map). No MUI, no styled-components.

## Layout

- `App.tsx` — top-level shell: TopAppBar + resizable Sidebar + ForceGraph + Legend. Project-scoped state is split across `hooks/` (`useActiveFolder`, `useProjectScan`, `useHiddenExtensions`, `useSidebarWidth`, `useStartupTerminalSync`); App itself is layout + wiring.
- `api/` — every backend call. Domain-grouped (`tasks.ts`, `mergeRuns.ts`, `workflows.ts`, `scan.ts`, `settings.ts`). Generic WS subscriber in `ws.ts`. Components import from `'../api'` which resolves to `api/index.ts`.
- `components/` — UI. Big launchers live in subdirectories with shim re-exports at the top level (`TaskBoard.tsx` → `taskboard/`, `Workflows.tsx` → `workflows/`, `ForceGraphView.tsx` → `forceGraph/`).
- `TerminalsContext.tsx` — global terminal-tab state, persisted to sessionStorage (per-tab). `addTerminal({...})` is how features spawn agent sessions.
- `extensionStyles.ts` — single source of truth for sprite shape/color per file extension. Shared by graph + Legend.
- `workflowTemplates.ts` — built-in templates surfaced in the Workflows picker.

## Per-project state keys

- `localStorage`: `lattice.hiddenExts.<path>`, `lattice.graphSettings.<path>`, `lattice.<panel>.window`.
- `sessionStorage`: `lattice.activeFolder`, `lattice.terminals` (both per-tab so multiple tabs each track their own project + terminal list independently).
- Backend: `<project>/.lattice/userSettings.json` (sidebar width, harness).

## Type-check

`npx tsc -b` from `frontend/`. The 3d-force-graph TS warning is pre-existing — vite still runs.
