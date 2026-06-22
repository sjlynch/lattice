# frontend/src/components/taskboard/hooks

Where the taskboard's real logic lives. `TaskBoardLauncher.tsx` is a thin
wiring shell — it composes these hooks and renders them to JSX. Most are
consumed via the composers (`useTaskBoardState`, `useTaskActions`); the rest
the launcher calls directly.

## State / data-sync

- `useTaskList.ts` — per-folder task list: initial fetch + live `/ws/tasks` subscription, structural sharing so unchanged cards skip re-render, and the shared error-toast slot (`showError`).
- `useTaskBoardState.ts` — composes `useTaskList` + `useTaskSelection`; adds lane grouping/sorting and derived board counts.
- `useTaskSearch.ts` — case-insensitive search box state; derives `filteredTasks`/`filteredGrouped` and the `searchActive` flag that gates lane "run all".
- `useTaskSelection.ts` — multi-selection on cards: selected ids, shift-range anchor, and the lane the selection is anchored in (cross-lane ranges reset).
- `useVisibleLanes.ts` — lane-visibility toggle set for the filter chips (all visible by default).
- `useLaneSort.ts` — per-lane arrival-date sort mode (`recent`/`oldest`/`manual`, default `recent`), persisted per project (`lattice.laneSort.<path>`); backs the lane header clock + caret. `setManual` is wired to slot drops so manual reorder survives.
- `useSyncedViewedTask.ts` — keeps the detail overlay's viewed task fresh against live updates; closes the overlay if the task disappears.
- `useTaskDetailEdit.ts` — the detail overlay's editable title/description draft, dirty check, and save-payload prep (resets only when the task changes).
- `useHarnessSelector.ts` — agent-harness dropdown: installed CLIs, the curated Pi model menu (`GET /api/pi-models`), the persisted per-project choice (`{harness, piModel}`), and the round-robin pick used in `interleave` mode. `pickRunHarness()` returns `{harness, piModel}` for run/resume; the dropdown value encodes both (`pi:<provider/model>`).

## Task actions

- `useTaskActions.ts` — composes the four per-concern action hooks below into the single shape the launcher consumes. Add new actions in the matching focused hook, not here.
- `useTaskCrudActions.ts` — add/edit/delete plus the plain status-change `moveTask`.
- `useTaskReorderActions.ts` — drag/drop reorder math (`dropAt`/`moveMulti`/`dropAtMulti`); computes a lane's new ID order and ships one batched reorder.
- `useTaskLifecycleActions.ts` — `runTask`/`resumeTaskAction` + the lane-level "run/resume all"; requests go through the backend spawn queue (terminals mount later via the `task-spawned` event).
- `useTaskMergeActions.ts` — per-task `mergeTaskAction` (resolver-Claude spawn on conflict), `mergeAllReady`, `cancelActiveRun`, and `markAllQaDone`.
- `useLaneDropTargets.ts` — lane-level drop targeting: background-hover state, per-slot hover index, and the `slotProps` factory `Lane.tsx` uses; drives the reorder actions above.

## Run orchestration

- `useMergeRunSync.ts` — hydrates + live-syncs the backend "merge all" run; spawns the resolver Claude on conflict events and toasts each new per-task error once.
- `usePushRun.ts` — QA-lane Push button: probes for `.git`, starts a push run, polls it, and tears down the local terminal when the Stop hook flips it to `done`.
- `useQaRuns.ts` — QA-lane "run e2e test" buttons; spawns a Playwright Claude per run (tracked by terminal id — deliberately no `taskId`) and polls to auto-close on `done`.
- `useQaPlaywright.ts` — reads/persists the QA-lane Playwright MCP toggle (`userSettings.qaPlaywright`); the backend reads it at spawn time (QA runs only).
- `usePostMergeHook.ts` — PostMergeHookRow state: the persisted prompt/harness form plus the live active/recent hook run (terminal spawn + abort).

## Terminal lifecycle

- `useTaskTerminalCleanup.ts` — closes task terminals on lifecycle transitions: qa/done/deleted close all, ready-to-merge closes only the worktree-agent pty (resolvers left alone).
- `useTaskTerminalFocus.ts` — task→pty focus map (`getFocusTerminal`) plus a serverId-based focuser for the post-merge hook row (which has no task).
- `useTaskTerminalReattach.ts` — one-shot on board load: re-mounts terminals for `in_progress` tasks whose pty is alive in the terminal-server but not mounted in this browser tab.
