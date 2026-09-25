# frontend/src/components/sidebar

Implementation pieces for `../Sidebar.tsx`.

- `NewTerminalDropdown.tsx` — plus/chevron menu for Claude, dangerous Claude,
  Pi, Codex, and plain terminal sessions; command defaults live in `constants.ts`.
  **Sidebar harness launches pre-create their pty through the backend.**
  `hooks/useNewTerminal.ts`'s `newTerminal` calls `createBackendSession` (`terminal/terminalApi.ts`
  → `POST /api/terminals`) for any spec with an `initialCommand`, then `addTerminal`s
  with the returned `serverId` so the pane attaches to the already-configured pty
  by id. This is what routes a Codex/Pi terminal through the spawn chokepoint
  (`resolveHarnessSpawnBody`) so its MCP config is applied — a serverless
  `/ws/terminal` connect bypasses that, and only Claude survives it (via the
  persistent `~/.claude.json` reconcile). A plain terminal (no `initialCommand`)
  or a pre-create failure falls back to the serverless connect. Since the
  terminal-tab registry, EVERY kind (plain shells too) and the startup terminals
  (`useStartupTerminals` → `spawnStartup`) pre-create this way, passing the
  tab's `label` / `owner` / `startupId` so the record carries them; the returned
  `terminalId` becomes the tab's own id (`registered: true`). Only a pre-create
  failure leaves a tab serverless — and therefore not restorable.
  Beneath bare "Pi" the menu also lists one **"Pi — <model>"** row per curated Pi model
  (the `GET /api/pi-models` `.menu`, fetched once in `Sidebar.tsx` and passed as
  `piMenu`). Picking one spawns `pi --approve --model "<provider/model>"` —
  per-spawn model selection, same as the taskboard/workflow harness pickers.
  `createTerminalSpec` builds that command (guarded by `harnesses.isValidPiModel`)
  and a short `pi <model> N` tab label. Bare Pi launches `pi --approve`; that
  project-trust flag (official Pi ≥0.74) is what lets a project-root sidebar `pi`
  load Lattice's cwd-local `.pi/extensions/` shims (MCP / subagents / completion)
  + `.pi/mcp.json` — the same flag the backend adds at every spawn site
  (`agentCommandBuilder.ts`). A new **Codex** terminal launches `codex --yolo` by
  default (Codex's permission bypass, the analogue of the dangerous-Claude
  `--dangerously-skip-permissions`); `createTerminalSpec` drops the flag to plain
  `codex` when the `codexYolo` setting (Settings → Terminals) is off — the flag
  is passed down from `terminalLaunchSettings.codexYolo`.
- `hooks/useNewTerminal.ts` — `{ newTerminal, defaultKind }` for the dropdown:
  `newTerminal` is the pre-create-then-`addTerminal` launch described above;
  `defaultKind` maps `terminalDefaultHarness` (+ `terminalClaudeSkipPermissions`
  → `claude-yolo`) to the plus button's kind.
- `SidebarSearchBox.tsx` — the inline search field + clear button (state from
  `hooks/useTerminalSearch`); `Sidebar.tsx` renders it only when the viewed
  panel has tabs.
- `SidebarHeaderActions.tsx` — the header's right-hand buttons: restart-all
  (Startup panel), restore-tabs + `NewTerminalDropdown` (Terminals panel).
  Header icon size is `HEADER_ICON_SIZE` in `constants.ts`.
- `RestoreNotice.tsx` — the strip under the header for the registry restore:
  the 'ask'-mode prompt ("N tabs from your last session can be restored") and
  the last pass's summary (`describeRestoreSummary`: re-attached / relaunching /
  dropped-with-reason). The header also carries a manual "Restore tabs" button.
- `SidebarPanelTabs.tsx` — Terminals / Merging / Startup panel switcher (Merging
  tab carries a count badge; each shown only when non-empty).
- `SidebarTabsBar.tsx` — the scrollable tab strip: scroll arrows, HTML5
  drag-and-drop reordering state, and which tab is mid-rename (`editingId`); maps
  `visibleTerminals` to `SidebarTab` rows, marking each `busy` by intersecting its
  `serverId` with `busyServerIds` (from `hooks/useBusyAgentTerminals`). Dropping a tab on another calls
  `reorderTerminal` from `TerminalsContext`, which reorders the full persisted
  list by id so it stays correct under panel/search filtering.
- `SidebarTab.tsx` — one memoized tab row: kind icon (terminal/merge/startup),
  label or the inline rename input, a status dot for the attention states
  (reconnecting/exited/dead), and a close button. Double-click starts a rename,
  right-click opens the context menu; the label doubles as the searchable session
  name (see `useTerminalSearch`). Memoized so only the tabs whose flags change
  re-render on a `TerminalsContext` update or drag. When `busy` is set the kind
  icon is **replaced** by a spinner (`.sidebar-tab-spinner`) — it takes the
  icon's slot rather than adding a glyph so the strip's tab widths don't jitter
  as agents start and stop.
- `RenameInput.tsx` — the rename `<input>` leaf: seeds its draft from the current
  label and owns per-keystroke state (so churn never reaches sibling tabs). A
  `doneRef` guard keeps the exact semantics — Enter or blur commits once, Escape
  cancels — even though unmounting the focused input also fires blur.
- `TabContextMenu.tsx` — the right-click popover (Close Tabs to the Left / Right /
  All Others), fixed-positioned at the click point; each item disables when
  there's nothing on that side. State/handlers come from `hooks/useTabContextMenu`.
- `SidebarPanes.tsx` — the pane list under the tab strip. Renders a
  `.sidebar-pane` wrapper for EVERY `projectTerminals` entry unconditionally
  (each pane built by Sidebar's `renderPane` → `TerminalPane`), with
  `SidebarEmptyState` as a *sibling* when the viewed panel is empty — never a
  replacement. Swapping the list for the message unmounted every mounted pane
  in the project on a `switchPanel('terminals')` with only startup tabs
  (force-mounted startup panes lost their WS + xterm, cost a ~2 MB replay on
  return, and a serverless pane without its `attached` frame yet reconnected
  as a second pty). Pinned by `__tests__/sidebarPanesMount.test.ts`.
- `SidebarEmptyState.tsx` — per-panel empty messaging.
- `hooks/useTerminalGroups.ts` — project-scoped regular/merge/startup grouping.
  Scoping goes through `terminal/terminalScope.ts`'s `terminalBelongsToProject`:
  a terminal is listed only when its `projectPath` matches the active folder, or
  (for **legacy** specs missing `projectPath`) when its `cwd` equals/descends
  from it. Never fall back to showing `!projectPath` terminals in every project
  — that surfaced a wrong-repo shell after a sessionStorage-shape upgrade.
- `hooks/usePanelState.ts` — active panel + `activeId` reconciliation and
  auto-switching (matches the panel to the active terminal; falls back to
  Terminals when a Merging/Startup panel empties). Deliberately does NOT steal
  focus to a spawned merge resolver (a "Merge All" burst would mount many panes
  and blow past Chrome's WebGL context cap). Pure logic (`panelForKind`,
  `shouldFallBackToTerminals`) lives in `hooks/panelState.ts`.
- `hooks/useTerminalSearch.ts` / `useTabScrolling.ts` — filter state and tab
  scroll affordances. The search field is always visible inline with the panel
  tabs (no longer a toggle) and filters the active panel's tabs by label + cwd;
  Escape clears it. `switchPanel` resets the filter when changing panels.
- `hooks/useTabContextMenu.ts` — close-left/right/others state + actions (each
  confirms the bulk close first, since the ptys are killed); the popover markup is
  rendered by `TabContextMenu.tsx`. The targets come from the pure
  `hooks/tabBulkClose.ts` (`bulkCloseTargets`), which closes NOTHING when the
  menu's tab has left the visible list meanwhile (an index of -1 used to target
  every tab).
- `hooks/useStartupTerminals.ts` — validates/reseeds startup ptys and exposes
  restart-all. The seeding decision is the pure `startupSeedPlan.ts`
  (`planStartupSeeding`, unit-tested): it reads `GET /api/terminals` AND the
  registry snapshot (`fetchTerminalTabs`), because the sidebar's local list
  lags the registry — on a fresh browser context it is EMPTY until the
  snapshot lands, and deciding from it alone spawned a second `npm run dev`
  for a startup whose pty was alive and about to be re-attached. A startup
  record with a live pty blocks the spawn; a dead or ended one does not (the
  restore pass ends dead startup records silently and this hook reseeds).
  Its stale-drop (a spec whose `serverId` is no longer live) applies ONLY to
  unregistered legacy specs: a registered tab's dead pty is the registry
  restore's to relaunch, and closing it here would DELETE the record.
  When BOTH reads fail (backend restarting under the page) the effect retries
  the pair a few times (`SEED_FETCH_ATTEMPTS` / `SEED_FETCH_RETRY_MS`, mirroring
  `TerminalsContext`'s registry fetch) and `planStartupSeeding` then spawns
  NOTHING from two nulls — live ptys survive a backend restart, so guessing
  from an empty local list put a second `npm run dev` beside the live one.
  A spawn's in-flight marker (`startupInFlightKey`, normalized folder) is
  dropped only once its spec has COMMITTED (`settleInFlightStartups`); it used
  to be dropped by any unrelated list change during the pre-create await.
- `hooks/useMountedTerminalIds.ts` — owns `mountedIds`: lazy-mounts
  `TerminalPane` only after first activation (startup panes excepted), which
  prevents WebGL context exhaustion across many pre-spawned panes. A tab in a
  registry `restore` state (pending / failed) is never force-mounted, and
  `Sidebar.tsx` keys each pane on `relaunchNonce` so a relaunched tab remounts
  against its new pty.
- `hooks/useBusyAgentTerminals.ts` — the `serverId` set behind the per-tab
  spinner, from `/ws/terminal-activity` (see `backend/src/terminalActivity.ts`).
  Deliberately **not** derived from the panes: `useMountedTerminalIds` above
  means an un-clicked tab has no terminal WS at all, and after a "Run All" those
  are precisely the tabs you want a spinner on. Returns the SAME `Set` reference
  for an unchanged frame (a reconnect re-sends the current set) so the memoized
  `SidebarTab` rows don't re-render on it.
  Project switches hide the previous snapshot before the first new-project
  commit. Disconnect clears this transient set and its shared WS replay cache;
  stale socket callbacks cannot restore it. `SidebarTab` suppresses the spinner
  for `exited`/`dead` terminals even if an activity snapshot still names them,
  while unopened tabs (no pane status yet) remain eligible.
