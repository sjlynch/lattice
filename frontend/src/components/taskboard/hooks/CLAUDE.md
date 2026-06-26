# frontend/src/components/taskboard/hooks

Where the taskboard's real logic lives. `TaskBoardLauncher.tsx` is a thin
FloatingPanel/JSX shell; `useTaskBoardController.ts` composes the task, merge,
push, QA, post-merge, harness, search, lane-sort, selection, and terminal
hooks into the single shape the launcher renders. Most lower-level hooks are
consumed via composers (`useTaskBoardController`, `useTaskBoardState`,
`useTaskActions`) rather than directly by components.

## State / data-sync

- `useTaskList.ts` — per-folder task list: initial fetch + live `/ws/tasks` subscription, structural sharing so unchanged cards skip re-render, and the shared error-toast slot (`showError`). Its returned list is project-guarded: on folder switch it reports `[]` until the new folder's fetch/WS snapshot arrives, so stale task IDs are never rendered/actionable under the next project.
- `useTaskBoardController.ts` — top-level taskboard controller: composes the concern hooks below and derives launcher handlers (sorted lanes, slot-drop wrappers, detail/new-task overlay actions, post-merge terminal focus). Keep new cross-concern wiring here so `TaskBoardLauncher.tsx` stays mostly panel chrome.
- `useTaskBoardState.ts` — composes `useTaskList` + `useTaskSelection`; adds lane grouping/sorting and derived board counts.
- `useTaskSearch.ts` — case-insensitive search box state; derives `filteredTasks`/`filteredGrouped` and the `searchActive` flag that gates lane "run all".
- `useTaskSelection.ts` — multi-selection on cards: selected ids, shift-range anchor, and the lane the selection is anchored in (cross-lane ranges reset).
- `useVisibleLanes.ts` — lane-visibility toggle set for the filter chips (all visible by default).
- `useLaneSort.ts` — per-lane arrival-date sort mode (`recent`/`oldest`/`manual`, default `recent`), persisted per project (`lattice.laneSort.<path>`); backs the lane header clock + caret. `setManual` is wired to slot drops so manual reorder survives.
- `useSyncedViewedTask.ts` — keeps the detail overlay's viewed task fresh against live updates; closes the overlay if the task disappears.
- `useTaskDetailEdit.ts` — the detail overlay's editable title/description draft, dirty check, and save-payload prep. Resets on a task switch; on a same-ID update it reconciles per field against a baseline ref (`reconcileEditFields`) — an untouched field adopts the server value (so a WS update lands instead of a stale local field clobbering it on Save), an edited field keeps the user's draft. `computeSavePayload` only sends fields changed vs the current server task.
- `useHarnessSelector.ts` — agent-harness dropdown: installed CLIs + the curated Pi model menu come from the shared `useHarnessAvailability` / `usePiModelMenu` hooks; this hook keeps only the persisted per-project choice (`{harness, piModel}`) and the round-robin pick used in `interleave` mode. `pickRunHarness()` returns `{harness, piModel}` for run/resume; the dropdown value encodes both (`pi:<provider/model>`). The folder-change settings load is guarded against fast project switches by a monotonic load-id ref + `loadHarnessForFolder` (`harnessSelectorLoad.ts`, pure + unit-tested): a project-A response that resolves after switching to B is dropped, so it can't overwrite B's selection or persist a coerced patch under A.

## Task actions

- `useTaskActions.ts` — composes the four per-concern action hooks below into the single shape the launcher consumes. Add new actions in the matching focused hook, not here.
- `useTaskCrudActions.ts` — add/edit/delete plus the plain status-change `moveTask`. `editTask`/`addTask`/`deleteTask` resolve `Promise<boolean>` (false on failure, after toasting) so callers can keep a modal open on a rejected save — `TaskDetailOverlay` awaits `editTask` and closes only on success.
- `useTaskReorderActions.ts` — drag/drop reorder math (`dropAt`/`moveMulti`/`dropAtMulti`); computes a lane's new ID order and ships one batched reorder.
- `useTaskLifecycleActions.ts` — `runTask`/`resumeTaskAction` + the lane-level "run/resume all"; requests go through the backend spawn queue (terminals mount later via the `task-spawned` event). The "run/resume all" variants (and `markAllQaDone`) return the ids they targeted so the launcher can drive a progress strip.
- `useBulkRunStrips.ts` — per-lane progress strips for the Open/In Progress/QA bulk actions (the Ready-to-Merge lane keeps its own `useMergeRunSync` strip). `beginBulk(lane, ids, kind)` starts tracking against the targeted ids; the strip clears once each task has spawned (left its lane) or been queued, then flips to a short auto-dismissing summary. Resume has no task-state signal, so its completion rides `task-spawned` via `noteBulkSpawned` (fed from the spawn handler through a ref).
- `useLaneBulkActions.ts` — owns `useBulkRunStrips` and assembles the per-lane `runAllActionByLane` map the lane grid renders (each Open/In-Progress/QA "run all" wraps its ids in `beginBulk`; Ready-to-Merge is `mergeAllReady` verbatim). Bridges the resume-strip's `noteBulkSpawned` back to `useTaskSpawnHandler` via `setBulkSpawnNotifier`. Pulled out of the launcher so it stays panel/layout composition.
- `useTaskMergeActions.ts` — per-task `mergeTaskAction` (resolver-Claude spawn on conflict), `mergeAllReady`, `cancelActiveRun`, `clearStuckConflicts` (Resolving-strip escape hatch — `POST /merge-aborted` per orphaned conflict task), and `markAllQaDone`.
- `useLaneDropTargets.ts` — lane-level drop targeting: background-hover state, per-slot hover index, and the `slotProps` factory `Lane.tsx` uses; drives the reorder actions above.

## Run orchestration

- `useMergeRunSync.ts` — hydrates + live-syncs the backend "merge all" run; spawns the resolver Claude on conflict events and toasts each new per-task error once.
- `usePushRun.ts` — QA-lane Push button: probes for `.git`, starts a push run, polls it, and tears down the local terminal when the Stop hook flips it to `done`.
- `useQaRuns.ts` — QA-lane "run e2e test" buttons; spawns a Playwright Claude per run (tracked by terminal id — deliberately no `taskId`) and polls to auto-close on `done`.
- `useQaPlaywright.ts` — reads/persists the QA-lane Playwright MCP toggle (`userSettings.qaPlaywright`); the backend reads it at spawn time (QA runs only).
- `usePostMergeHook.ts` — PostMergeHookRow state: the persisted prompt/harness form plus the live active/recent hook run (terminal spawn + abort).

## Terminal lifecycle

- `useTaskSpawnHandler.ts` — builds the `/ws/tasks` `task-spawned` handler (mount the queued task's terminal + ping the resume strip). Runs *before* the task list (which needs the handler), so the resume-strip notifier is bridged in later through a ref via the stable `setBulkSpawnNotifier`. Consumed by `useLaneBulkActions`.
- `useTaskTerminals.ts` — composer over the three lifecycle hooks below (focus + cleanup + reattach); the launcher wires all of taskboard's post-task-list terminal lifecycle in one call and gets back just the focus helpers (`getFocusTerminal` / `focusTerminalByServerId`).
- `useTaskTerminalCleanup.ts` — closes task terminals on lifecycle transitions: qa/done/deleted close all, ready-to-merge closes only the worktree-agent pty (resolvers left alone).
- `useTaskTerminalFocus.ts` — task→pty focus map (`getFocusTerminal`) plus a serverId-based focuser for the post-merge hook row (which has no task).
- `useTaskTerminalReattach.ts` — one-shot on board load: re-mounts terminals for `in_progress` tasks whose pty is alive in the terminal-server but not mounted in this browser tab. It only claims the per-project one-shot after a successful `/api/terminals` parse and uses bounded retry/backoff for transient HTTP/JSON failures or startup no-session races.
