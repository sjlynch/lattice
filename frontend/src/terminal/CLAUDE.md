# frontend/src/terminal

Helpers behind `../TerminalsContext.tsx`. The context file owns React state,
ref mirroring, persistence and context assembly. Helpers here keep list logic
and PTY side effects separate so each can be reasoned about on its own.
The terminal-list ref is mirrored in a layout effect so child lifecycle-cleanup
effects read the committed list, including tabs that just arrived.

- `terminalTypes.ts` — `TerminalSpec`, `Persisted`, `Ctx`. Re-exported as
  `TerminalSpec` from `../TerminalsContext` for backward compat.
- `terminalScope.ts` — pure per-project scoping predicate for the sidebar
  terminal list (`terminalBelongsToProject` + `isPathWithin`/`normalizeDirPath`),
  plus `sameProjectPath` — THE comparison for a backend-stamped `projectPath`
  (registry record, workflow, workflow run: `realpathSync.native` spelling)
  against the frontend's `activeFolder`; never `===` (a strict compare hid every
  workflow and dropped a started queue run on a casing/separator difference).
  A terminal with a recorded `projectPath` matches that project (normalized
  compare). The close-fallback grouping in `terminalActivePolicy.ts` and the
  startup seeding (`sidebar/hooks/startupSeedPlan.ts`) compare the same way. A
  **legacy** terminal persisted before `projectPath` existed (field missing) is
  scoped by its `cwd` — shown only when `cwd` equals/descends from the active
  folder. **Do NOT reintroduce the old `!projectPath` catch-all** (`filter((t)
  => !t.projectPath || t.projectPath === activeFolder)`): it listed — and let
  `useTerminalGroups`/the Sidebar auto-select — a legacy terminal whose `cwd`
  points at project A while the UI was showing project B, i.e. a shell from the
  wrong repo. Consumed by `components/sidebar/hooks/useTerminalGroups.ts`.
- `terminalStorage.ts` — `STORAGE_KEY = 'lattice.terminals'`, `loadPersisted`,
  `persist`. sessionStorage, not localStorage, so each browser tab tracks its
  own terminal list (two tabs on `lattice.terminals` would race writes). Since
  the registry (below) this is only a paint-before-fetch CACHE for registered
  tabs; the backend's records are the durable truth.
- `terminalRegistrySync.ts` — pure reconciliation with the backend's durable
  terminal-tab registry (`/api/terminal-tabs`, `/ws/terminal-tabs`; see
  `backend/src/terminalRegistry/CLAUDE.md`). `recordToSpec` projects a record
  onto a `TerminalSpec` (`registered: true`, `restore: 'pending'` while it has
  no pty, `'failed'` when ended as cwd-missing / restore-failed; transient
  `status` carried over only while the same pty backs the tab; `relaunchNonce`
  bumped when a DIFFERENT pty appears, which is what makes the Sidebar remount
  a pane that already gave up on the dead one). `mergeRegistryTabs` replaces a
  project's registered tabs with the registry's view, keeps unregistered
  fallback tabs unless a record owns their pty, and never touches other
  projects. `applyTerminalTabsEvent` folds the live events: `ended` removes for
  closed/killed/owner-finished, marks `exited` for exit (the tab stays until
  closed, like today), marks `failed` for restore failures. The context calls
  `POST /restore` on project open per the `restoreTerminalsOnOpen` setting and
  marks the summary's `relaunchedIds` from the HTTP response (the WS events can
  precede a fresh page's socket). **A tab in a `restore` state must never mount
  a pane** — a serverless attach would run its launch command a second time
  (`Sidebar.tsx` + `useMountedTerminalIds` both gate on it). The on-open pass
  is single-flighted PER PROJECT (a global slot once handed project B's pass
  project A's promise, marking B restored without restoring it); an explicit
  "Restore tabs" click always goes through so the backend's `already-running`
  can be shown. The registry fetch retries a few times (a backend still
  booting) and the WS `hello` snapshot also gates the auto-restore, so a slow
  fetch never leaves pending tabs unmountable. `mergeRegistryTabs` takes the
  ids of registered tabs created while a snapshot was in flight (`keepIds`)
  and keeps them when the older snapshot doesn't list them. Its `changedIds`
  fence preserves the current spec or removal for tabs changed by intervening
  registry events, including additions from another browser tab.
- `useTerminalRegistrySync.ts` — the React side of the above, called by
  `TerminalsProvider`: the registry fetch + `/ws/terminal-tabs` subscription
  effect, the once-per-project auto-restore effect, `runRestore`, and the
  `lastRestore` / `restorePrompt` state; returns `addedDuringFetchRef` for
  `addTerminal`. Owns async cancellation, restore single-flight and the
  captured-PTY fallback for missed queue events.
- `terminalRegistrySession.ts` — React-free generation fence created per
  registry subscription, with fresh identity on project revisits (A → B → A).
  Owns request generation capture, full-snapshot and changed-id increments
  (including restore acknowledgements), and queries for intervening changed
  ids or superseding snapshots. Retains changed ids, including tombstones,
  for that subscription's lifetime.
- `useTerminalActions.ts` — stable add/activate/rename/reorder/status and
  single/bulk/task-close callbacks, with explicit provider setters/refs.
  Called after registry sync so persistence → sync → order cleanup stays
  ordered. Owns the 300 ms order PATCH debounce (captures folder/order;
  cancelled only on unmount) and backend close IO outside state updaters.
  Registered tabs stay visible while closing; failures retain PTY ownership
  and show retry feedback. Unregistered closes still remove immediately.
  Repeated commands for an in-flight close skip additional continuations;
  empty/absent removals and all-failed bulk confirmations schedule no removal.
  Pending-close registry records project the same feedback after reconnect.
- `terminalState.ts` — barrel that re-exports the pure functions from the two
  modules below, so `./terminalState` stays the stable import surface for
  `TerminalsContext` and the tests.
- `terminalListOps.ts` — pure terminal-list mutations: `newTerminalId`, list ops
  (`addTerminalToList`, `removeTerminalFromList`, `removeTerminalsFromList`,
  `terminalIdsForTask`, `planCloseTerminals`, `setServerIdInList`,
  `setStatusInList`, `renameTerminalInList`, `reorderTerminalInList`). No
  active-id policy here — these only transform the list. Removal helpers and
  `setStatusInList` return the SAME array reference when nothing changed;
  `planCloseTerminals` walks the list once keyed by the id set (serverId DELETEs
  at most once).
- `terminalActivePolicy.ts` — active-id selection policies (`pickInitialActiveId`,
  `pickActiveAfterAdd`, `pickActiveAfterClose`, `pickActiveAfterCloseMany`) plus
  the private project-scoped panel grouping helpers they depend on
  (`terminalPanelKind` / `isSameFallbackGroup` / `terminalsInFallbackGroup`).
  Close fallbacks stay
  inside the closed terminal's project-scoped panel; single-close clamps the
  prior index there, while multi-close walks backward to the first survivor.
  `pickActiveAfterDisappear` covers the active tab vanishing before that
  fallback runs (Sidebar's effect): the registry's `ended` event for a close
  beats the DELETE response, so a same-project removal uses the same in-panel
  neighbour policy — never "last project tab", which focused a Startup tab. A
  project switch prefers a regular tab over Startup/Merging.
  `closeTerminalsForTask` collects ids via `terminalIdsForTask` and delegates
  to the batched `closeTerminals` (which plans the DELETE set with
  `planCloseTerminals`) so all of a task's terminals drop in ONE setState —
  looping single-close per id re-read a stale ref and resurrected siblings.
  `closeTerminals`/`closeTerminal` remove from the list **functionally**
  (`setTerminals(current => removeTerminals(current, idSet))`) so that when
  lifecycle cleanup closes several finalizing tasks in one React batch (Merge
  All finishing several resolvers, a multi-select delete), each call composes
  onto the latest list instead of the last non-functional `setTerminals`
  clobbering the earlier tasks' removals. The
  DELETE set + active-id fallback are still derived from the single pre-batch
  `terminalsRef` snapshot, kept out of the StrictMode-double-invoked updater.
  `planCloseTerminals` walks the list once keyed by the id set, so a serverId
  DELETEs at most once even if an id repeats.
- `terminalApi.ts` — `deleteBackendSession(serverId)`. The one side effect
  out of band. Kept out of any setState updater on purpose: StrictMode dev
  re-runs updaters and would fire two DELETEs in <100ms, which on Windows
  crashed node-pty's helper subprocess and the whole backend with it.

If you add a new mutation, put the data transform in `terminalListOps.ts` (or a
new active-id rule in `terminalActivePolicy.ts`), re-export it from the
`terminalState.ts` barrel, and keep `fetch`/IO calls in `useTerminalActions`
(or `terminalApi.ts`).
