# frontend/src/components/sidebar

Implementation pieces for `../Sidebar.tsx`.

- `NewTerminalDropdown.tsx` — plus/chevron menu for Claude, dangerous Claude,
  Pi, Codex, and plain terminal sessions; command defaults live in `constants.ts`.
  Beneath bare "Pi" it also lists one **"Pi — <model>"** row per curated Pi model
  (the `GET /api/pi-models` `.menu`, fetched once in `Sidebar.tsx` and passed as
  `piMenu`). Picking one spawns `pi --model "<provider/model>"` — per-spawn model
  selection, same as the taskboard/workflow harness pickers. `createTerminalSpec`
  builds that command (guarded by `harnesses.isValidPiModel`) and a short
  `pi <model> N` tab label.
- `SidebarPanelTabs.tsx` — Terminals / Merging / Startup panel switcher.
- `SidebarTabsBar.tsx` — scrollable terminal tabs, close buttons, the
  right-click entry point, double-click-to-rename (inline `<input>`;
  Enter/blur commits, Escape cancels; the label doubles as the searchable
  session name — see `useTerminalSearch`), and HTML5 drag-and-drop reordering
  (drop a tab on another to reorder; calls `reorderTerminal` from
  `TerminalsContext`, which reorders the full persisted list by id so it's
  correct under panel/search filtering).
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
