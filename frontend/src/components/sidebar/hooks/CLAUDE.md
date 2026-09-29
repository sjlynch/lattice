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
- `useMountedTerminalIds.ts` — tracks tabs eligible to mount panes, including startup and missing-session cases.
- `useBusyAgentTerminals.ts` — project-scoped busy `serverId` set from the backend activity feed.

## Invariants

- **Launch:** `createTerminalSpec` -> `createBackendSession` (`POST /api/terminals`)
  for every shell/harness kind -> `addTerminal` with `id: terminalId`, `serverId`
  and `registered: !!terminalId` -> pane attach by `serverId`. Startup launches
  use the same pre-create/add/attach path with `owner: 'startup'` and `startupId`;
  dropdown launches use `owner: 'user'`. This preserves registry identity and
  harness spawn configuration. Only failed pre-creation adds a serverless,
  unregistered fallback tab; `useMountedTerminalIds` mounts it so WS attach can
  create its PTY. That tab is not restorable. Backend details belong to the
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
- **Pane lifetime:** pre-created panes mount lazily on first activation;
  startup panes are force-mounted. Pending/failed `restore` tabs never render
  a pane (`SidebarPanes` gates even a remembered mounted id). Sidebar keys panes
  on `relaunchNonce`, not captured `serverId`, so restore can remount a new PTY
  without recreating xterm on initial id capture. See the
  [view/connection guide](../../terminal/CLAUDE.md) for attach and WebGL ownership.
- **Bulk close:** close the menu before confirming the count; only confirmation
  calls `closeTerminals`, which kills PTYs. Resolve targets against the current
  visible order; a menu whose tab disappeared/was filtered out closes nothing.
- **Activity:** `/ws/terminal-activity` is authoritative even for unopened panes;
  classification belongs to [backend `terminalActivity.ts`](../../../../../backend/src/terminalActivity.ts).
  Unchanged frames keep the same `Set` identity. Hide the previous project's
  snapshot before the new-project commit and fence callbacks after cleanup.
  `api/terminals.ts` + `api/ws.ts` clear the transient set and shared replay cache
  on disconnect and reject stale socket callbacks; reconnect needs fresh data.
