# frontend/src/components/sidebar/hooks

Hooks and pure helpers composed by [Sidebar.tsx](../../Sidebar.tsx).
The [parent guide](../CLAUDE.md) maps the UI; [terminal state](../../../terminal/CLAUDE.md)
owns shared tab mutations, scoping and registry reconciliation.

## Ownership

- `useNewTerminal.ts` — dropdown `newTerminal` and `defaultKind`; spec commands/labels come from `../constants.ts`'s `createTerminalSpec`.
- `useStartupTerminals.ts` / `startupSeedPlan.ts` — live-session validation, startup admission and restart-all; pure `planStartupSeeding`, `planRestart`, `startupInFlightKey` and `settleInFlightStartups`.
- `useTerminalGroups.ts` — project-scoped regular/merge/startup lists via `terminalScope.ts`'s `terminalBelongsToProject`.
- `usePanelState.ts` / `panelState.ts` — panel/active-id reconciliation and switching; pure `panelForKind` and `shouldFallBackToTerminals`.
- `useTerminalSearch.ts` — current-panel label/cwd filtering, Escape clear, input ref and reset callback.
- `useTabScrolling.ts` — strip/active-tab refs, scroll arrows and active-tab visibility; pure `computeTabScrollState` and DOM subscription `subscribeTabScroll`.
- `useTabContextMenu.ts` / `tabBulkClose.ts` — menu state, dismiss and confirmed close actions; pure `bulkCloseTargets` resolves targets in visible order.
- `useMountedTerminalIds.ts` — pane eligibility and activation history reconciled against the full global `terminals` list from `useTerminals()`; scoped lists supply force-mount candidates only.
- `useBusyAgentTerminals.ts` — project-scoped busy `serverId` set from the backend activity feed.

## Invariants

- **Launch:** every shell/harness pre-creates via `createBackendSession` before
  `addTerminal`, using backend `terminalId` as tab `id`, `serverId` for attach
  and `registered: !!terminalId`. Dropdown/startup owners are `user`/`startup`
  (startup also carries `startupId`), preserving registry identity and spawn
  configuration. Only failed pre-creation adds an unregistered, serverless,
  non-restorable fallback; pane WS attach then creates its PTY. Details belong to the
  [terminal](../../../../../backend/src/terminal/CLAUDE.md) and
  [registry](../../../../../backend/src/terminalRegistry/CLAUDE.md) guides.
- **Scope:** compare project paths through `terminalBelongsToProject` /
  `normalizeDirPath`, including startup marker keys. Legacy specs missing
  `projectPath` belong only where `cwd` equals/descends from the active folder.
  Startup planners consume already-scoped lists; strict path equality or a
  missing-`projectPath` catch-all can expose wrong-project tabs or duplicate spawns.
- **Startup admission:** consult both `GET /api/terminals` and
  `fetchTerminalTabs(activeFolder)` alongside local specs. A non-ended startup
  registry record with a live PTY blocks spawning; confirmed dead/ended records do not.
  Unreadable live IDs mean unknown, not empty. Retry incomplete reads; if both
  remain unreadable, plan neither spawns nor stale drops. Drop stale specs only
  when unregistered; registered records belong to registry reconciliation.
- **Startup deduplication:** reserve normalized folder/startup-id markers before
  awaiting pre-creation; `settleInFlightStartups` clears them only after the
  matching spec commits, never on unrelated list changes. Restart-all closes
  the scoped startup tabs, uses `planRestart` to skip in-flight configs, reserves
  the same markers, and keeps `restartPending` until its spawn promises settle.
- **State/IO:** backend creates/deletes and registry writes stay outside React
  state updaters; StrictMode can re-run those updaters. Shared close/list logic
  belongs to `TerminalsContext` and the terminal-state guide linked above.
- **Panels/search/scroll:** an empty target panel clears `activeId`; disappearing
  Merging/Startup panels fall back to Terminals. New merge resolvers do not
  steal focus. Sidebar clears search on manual and automatic panel changes.
  Scroll subscriptions must attach when the strip appears after an empty list.
- **Pane lifetime:** activation history is bounded by the full global `terminals`
  list passed by `Sidebar`, never `projectTerminals`, a panel or a search-filtered
  list. Remove IDs only after global removal; surviving tabs retain viewed status
  across project/panel switches and pending or failed registered closes. A stale
  `activeId` cannot reinsert a removed ID; no-op reconciliation preserves `Set`
  identity. Pre-created panes remain lazy until activation; startup and serverless
  fallback tabs are force-mounted. Pending/failed `restore` tabs never render a
  pane (`SidebarPanes` gates even remembered IDs), and restore tabs are excluded
  from serverless fallback mounting to avoid duplicate launches. Sidebar keys panes
  on `relaunchNonce`, not captured `serverId`, so restore can remount a new PTY
  without recreating xterm on initial ID capture. Retained IDs are bookkeeping;
  xterm and WebGL ownership stays in the
  [view/connection layer](../../terminal/CLAUDE.md). Pruning history does not
  identify the cross-PC browser OOM cause.
- **Mounted-pane cost:** the mounted set has no cap (`SidebarPanes` renders every
  remembered ID; `useMountedTerminalIds` only prunes globally removed tabs). Each
  mounted pane keeps its xterm `Terminal` and a live `/ws/terminal` socket and
  keeps parsing output while hidden. Only the active pane holds a WebGL context
  (`useActiveTerminalWebgl`). Rendering pauses only because `.sidebar-pane.hidden`
  in `styles/sidebar.css` adds `transform: translateX(-200%)`: it moves the pane
  outside the clipped `.sidebar-content`, so xterm's IntersectionObserver pauses
  it (`visibility: hidden` alone does not, and `display: none` /
  `content-visibility: hidden` break fit). Do not simplify it back to
  visibility-only. Scrollback is 20 000 lines (`terminal/terminalConfig.ts`), up to
  tens of MB per pane at 120 columns. Remounting after A -> B -> A re-attaches every
  remembered pane, each replaying up to `SCROLLBACK_REPLAY_BYTES` (2 MB,
  `backend/src/terminalConfig.ts`). The pending-output bound per pane is
  documented in the [terminal guide](../../terminal/CLAUDE.md).
- **Bulk close:** close the menu before confirming the count; only confirmation
  calls `closeTerminals`, which kills PTYs. Resolve targets against the current
  visible order; a menu whose tab disappeared/was filtered out closes nothing.
- **Activity:** `/ws/terminal-activity` is authoritative even for unopened panes;
  classification belongs to [backend `terminalActivity.ts`](../../../../../backend/src/terminalActivity.ts).
  Unchanged frames keep the same `Set` identity. Hide the previous project's
  snapshot before the new-project commit and fence callbacks after cleanup.
  `api/terminals.ts` + `api/wsSharedChannels.ts` (shared channels and their replay
  cache; `api/ws.ts` is only a compatibility re-export) clear the transient set and
  shared replay cache on disconnect and reject stale socket callbacks; reconnect
  needs fresh data.

## References

[Bounded-history scenarios](../../../__tests__/useTerminalRegistrySync.test.ts)
cover repeated removals/stale selection, `Set` identity, A -> B -> A and panel
switches, pending/failed registered closes, lazy panes and restore gates.

Reference commands (cwd `frontend/`): `npm run build`, `npm test`, `npx tsc -b`.
Task agents do not execute these checks; the separate Run tests step verifies merged work.
