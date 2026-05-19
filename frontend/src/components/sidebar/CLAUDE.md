# frontend/src/components/sidebar

Implementation pieces for `../Sidebar.tsx`.

- `NewTerminalDropdown.tsx` — plus/chevron menu for Claude, dangerous Claude,
  Pi, Codex, and plain terminal sessions; command defaults live in `constants.ts`.
- `SidebarPanelTabs.tsx` — Terminals / Merging / Startup panel switcher.
- `SidebarTabsBar.tsx` — scrollable terminal tabs, close buttons, and the
  right-click entry point.
- `SidebarEmptyState.tsx` — per-panel empty messaging.
- `hooks/useTerminalGroups.ts` — project-scoped regular/merge/startup grouping.
- `hooks/usePanelState.ts` — active panel + `activeId` reconciliation and
  auto-switching when merge/startup tabs appear.
- `hooks/useTerminalSearch.ts` / `useTabScrolling.ts` — filter state and tab
  scroll affordances.
- `hooks/useTabContextMenu.ts` — close-left/right/others state/actions; the
  popover markup is still inline in `Sidebar.tsx`.
- `hooks/useStartupTerminals.ts` — validates/reseeds startup ptys and exposes
  restart-all.
- `hooks/useMountedTerminalIds.ts` — owns `mountedIds`: lazy-mounts
  `TerminalPane` only after first activation (startup panes excepted), which
  prevents WebGL context exhaustion across many pre-spawned panes.
