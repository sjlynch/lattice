# frontend/src

Vite + React + TS UI. **To find which file owns X, read `MAP.md`** (this
folder; UI components: `components/MAP.md`). A folder with its own `CLAUDE.md`
owns its detail — read it before changing that folder.

## Rules for all frontend code

- **Styling:** hand-written CSS in `styles/` (`index.css` is an ordered
  `@import` list) + `lucide-react` icons; no MUI, no styled-components. A rule
  goes in the stylesheet that owns its class (`styles/CLAUDE.md`).
- **Every backend call goes through `api/`** (components import `'../api'`);
  WebSocket feeds through `api/wsTransport.ts` `subscribeWs` (`api/CLAUDE.md`).
- **Single sources of truth — never a second copy:** `extensionStyles.ts`
  (sprite shape/color per extension, shared by graph + Legend); `taskColors.ts`
  (task accent colors over the backend's `colorIndex` slot); `harnesses.ts` +
  `hooks/usePiModelMenu` / `hooks/useHarnessAvailability` (harness and Pi-menu
  data for every dropdown); `hooks/useUserSettings` (the single per-folder
  `userSettings.json` fetch — read your slice from it, don't fetch again).
- **Backend-shared code** (harness vocabulary, search pattern, wire types) is
  imported by path from `backend/src/shared/` (wire types via `api/types/`),
  never hand-mirrored.
- **Project paths:** `projectPath.ts` `canonicalProjectPath` only uppercases the
  Windows drive letter and can't resolve symlinks — never hash a frontend path
  to locate backend state. Compare backend-stamped paths with `activeFolder`
  through `normalizeDirPath` / `sameProjectPath` (`terminal/terminalScope.ts`),
  never `===`.
- **Agent sessions** are spawned through `TerminalsContext.tsx`
  `addTerminal({...})`, passing the backend's `terminalId` as `id` so the tab is
  the registry's (`terminal/CLAUDE.md`).
- **Memory:** `registerMemGauge` (`debug/memDiag.ts`) beside every long-lived
  collection / GPU resource; call the unregister it returns at teardown.
- **Per-project UI state:** `localStorage` `lattice.<thing>.<projectPath>`
  (builders in `storage/latticeLocalStorage.ts`; key list in `MAP.md`);
  `sessionStorage` (`lattice.activeFolder`, `lattice.terminals`) is per browser
  tab; persisted settings go to `<project>/.lattice/userSettings.json`.
- **Workflow templates** (`workflowTemplates.ts`): every agent step files tasks
  — never implements or commits (`WORKFLOW_STEP.md` forbids it); a template is a
  pure chain of agent steps — never bundle `start`/`merge`/`push` control steps
  (sole exception: `plan-build-ship`). A step's `tools` (e.g. `['opengrep']`)
  runs that pre-run tool before its harness; no per-step toggle.

## Build, type-check & tests

From `frontend/`: `npm run build` (TypeScript build + Vite bundle),
`npx tsc -b` (type-check, tests included), `npm test` (node:test via `tsx`
over `src/__tests__/*.test.ts`). From the repo root, `npm run typecheck` /
`npm test` cover both packages. Test conventions: `__tests__/CLAUDE.md`.
