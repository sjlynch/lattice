# frontend/src/components/sidebar

Implementation pieces for `../Sidebar.tsx`.

- `NewTerminalDropdown.tsx` — plus/chevron menu for Claude, dangerous Claude,
  Pi, Codex, and plain terminal sessions; command defaults live in `constants.ts`.
- `SidebarPanelTabs.tsx` — Terminals / Merging / Startup panel switcher.
- `SidebarTabsBar.tsx` — scrollable terminal tabs, close buttons, the
  right-click entry point, and double-click-to-rename (inline `<input>`;
  Enter/blur commits, Escape cancels). The label doubles as the searchable
  session name (see `useTerminalSearch`).
- `SidebarEmptyState.tsx` — per-panel empty messaging.
- `hooks/useTerminalGroups.ts` — project-scoped regular/merge/startup grouping.
- `hooks/usePanelState.ts` — active panel + `activeId` reconciliation and
  auto-switching when merge/startup tabs appear.
- `hooks/useTerminalSearch.ts` / `useTabScrolling.ts` — filter state and tab
  scroll affordances. The search field is always visible inline with the panel
  tabs (no longer a toggle) and filters the active panel's tabs by label + cwd;
  Escape clears it. `switchPanel` resets the filter when changing panels.
- `hooks/useTabContextMenu.ts` — close-left/right/others state/actions; the
  popover markup is still inline in `Sidebar.tsx`.
- `hooks/useStartupTerminals.ts` — validates/reseeds startup ptys and exposes
  restart-all.
- `hooks/useMountedTerminalIds.ts` — owns `mountedIds`: lazy-mounts
  `TerminalPane` only after first activation (startup panes excepted), which
  prevents WebGL context exhaustion across many pre-spawned panes.
