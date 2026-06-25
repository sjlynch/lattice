# frontend/src/terminal

Helpers behind `../TerminalsContext.tsx`. The context file owns React state +
effects; everything else lives here so the reducer logic and the pty-DELETE
side effect can each be reasoned about (and changed) on their own.

- `terminalTypes.ts` — `TerminalSpec`, `Persisted`, `Ctx`. Re-exported as
  `TerminalSpec` from `../TerminalsContext` for backward compat.
- `terminalStorage.ts` — `STORAGE_KEY = 'lattice.terminals'`, `loadPersisted`,
  `persist`. sessionStorage, not localStorage, so each browser tab tracks its
  own terminal list (two tabs on `lattice.terminals` would race writes).
- `terminalState.ts` — pure functions: `newTerminalId`, list ops
  (`addTerminalToList`, `removeTerminalFromList`, `removeTerminalsFromList`,
  `terminalIdsForTask`, `planCloseTerminals`, `setServerIdInList`), and
  active-id selection policies (`pickInitialActiveId`, `pickActiveAfterAdd`,
  `pickActiveAfterClose`, `pickActiveAfterCloseMany`). Close fallbacks stay
  inside the closed terminal's project-scoped panel; single-close clamps the
  prior index there, while multi-close walks backward to the first survivor.
  `closeTerminalsForTask` collects ids via `terminalIdsForTask` and delegates
  to the batched `closeTerminals` (which plans the DELETE set + post-close list
  with `planCloseTerminals`) so all of a task's terminals drop in ONE setState
  — looping single-close per id re-read a stale ref and resurrected siblings.
  `planCloseTerminals` walks the list once keyed by the id set, so a serverId
  DELETEs at most once even if an id repeats.
- `terminalApi.ts` — `deleteBackendSession(serverId)`. The one side effect
  out of band. Kept out of any setState updater on purpose: StrictMode dev
  re-runs updaters and would fire two DELETEs in <100ms, which on Windows
  crashed node-pty's helper subprocess and the whole backend with it.

If you add a new mutation, put the data transform in `terminalState.ts` and
keep `fetch`/IO calls in the context callbacks (or `terminalApi.ts`).
