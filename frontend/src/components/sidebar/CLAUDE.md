# frontend/src/components/sidebar

Implementation pieces for `../Sidebar.tsx`.

- `NewTerminalDropdown.tsx` — plus/chevron menu for Claude, dangerous Claude,
  Pi, Codex, and plain terminal sessions; command defaults live in `constants.ts`.
  **Sidebar harness launches pre-create their pty through the backend.**
  `Sidebar.tsx`'s `newTerminal` calls `createBackendSession` (`terminal/terminalApi.ts`
  → `POST /api/terminals`) for any spec with an `initialCommand`, then `addTerminal`s
  with the returned `serverId` so the pane attaches to the already-configured pty
  by id. This is what routes a Codex/Pi terminal through the spawn chokepoint
  (`resolveHarnessSpawnBody`) so its MCP config is applied — a serverless
  `/ws/terminal` connect bypasses that, and only Claude survives it (via the
  persistent `~/.claude.json` reconcile). A plain terminal (no `initialCommand`)
  or a pre-create failure falls back to the serverless connect. NOTE: startup
  terminals (`useStartupTerminals`) still connect serverlessly — a harness set as
  a startup command would not get MCP; the manual dropdown is the covered path.
  Beneath bare "Pi" it also lists one **"Pi — <model>"** row per curated Pi model
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
- `SidebarPanelTabs.tsx` — Terminals / Merging / Startup panel switcher (Merging
  tab carries a count badge; each shown only when non-empty).
- `SidebarTabsBar.tsx` — the scrollable tab strip: scroll arrows, HTML5
  drag-and-drop reordering state, and which tab is mid-rename (`editingId`); maps
  `visibleTerminals` to `SidebarTab` rows. Dropping a tab on another calls
  `reorderTerminal` from `TerminalsContext`, which reorders the full persisted
  list by id so it stays correct under panel/search filtering.
- `SidebarTab.tsx` — one memoized tab row: kind icon (terminal/merge/startup),
  label or the inline rename input, a status dot for the attention states
  (reconnecting/exited/dead), and a close button. Double-click starts a rename,
  right-click opens the context menu; the label doubles as the searchable session
  name (see `useTerminalSearch`). Memoized so only the tabs whose flags change
  re-render on a `TerminalsContext` update or drag.
- `RenameInput.tsx` — the rename `<input>` leaf: seeds its draft from the current
  label and owns per-keystroke state (so churn never reaches sibling tabs). A
  `doneRef` guard keeps the exact semantics — Enter or blur commits once, Escape
  cancels — even though unmounting the focused input also fires blur.
- `TabContextMenu.tsx` — the right-click popover (Close Tabs to the Left / Right /
  All Others), fixed-positioned at the click point; each item disables when
  there's nothing on that side. State/handlers come from `hooks/useTabContextMenu`.
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
  rendered by `TabContextMenu.tsx`.
- `hooks/useStartupTerminals.ts` — validates/reseeds startup ptys and exposes
  restart-all.
- `hooks/useMountedTerminalIds.ts` — owns `mountedIds`: lazy-mounts
  `TerminalPane` only after first activation (startup panes excepted), which
  prevents WebGL context exhaustion across many pre-spawned panes.
