# Spawn Queue — Implementation Plan

> Status: **COMPLETE** — all three phases shipped (2026-05-21). Backend +
> frontend type-check clean, 123 backend tests pass. Only the optional
> fake-terminal-server integration test (§12) is left unbuilt.
> Context: under heavy "Run All" / multi-workflow fan-out, agent spawns hit the
> terminal-server's hard session cap and were **dropped** (a workflow step
> errored out; tasks silently failed to spawn). This plan replaces that hard
> rejection with a durable admission queue so requested work is deferred,
> never lost.
>
> ## Implementation progress (Phase 1 — done)
>
> Decisions locked in while building:
> - **softCap default = 24**, `PRIORITY_RESERVE = 6`, poll interval 1.5 s,
>   hard cap raised 50 → 200. softCap is env-overridable via
>   `LATTICE_MAX_CONCURRENT_AGENTS`. 24 is a sustainable-concurrency default
>   (the incident pegged CPU at ~50); the queue makes concurrency a throughput
>   knob, not a ceiling on total queued work.
> - `startTaskById` flips a task to `in_progress` **after** the pty spawn
>   (was: before), so a CAP-rejected spawn leaves the task `open` and the
>   queue thunk is safely re-runnable. New `throwOnCapacity` option: the
>   queue path throws `SpawnCapacityError` on CAP; the workflow control-step
>   path keeps today's "proceed without a terminal" behaviour.
> - `task-spawned` is delivered as a second event type on the existing
>   `/ws/tasks` socket (no new socket), via a `taskSpawnEvents.ts` pub/sub.
> - `notifySessionsFreed` exists in the facade but kill sites are wired in
>   Phase 2; Phase 1 reclaims freed slots via the 1.5 s poll.
> - `task-spawned` events carry the task's **raw** projectPath (so the
>   frontend terminal's projectPath matches `activeFolder` for the
>   `useTerminalGroups` filter); the `/ws/tasks` connection filter
>   canonicalizes it.
> - Behaviour change accepted (per §7): task-run terminals now mount in
>   **every** browser tab watching the project, not just the initiating tab
>   — same model as workflow `step-spawned`. Terminals lazy-mount, so this is
>   only extra tabs in the strip, no WebGL cost.
>
> ### Phase 1 — files delivered
>
> New: `spawnQueue.ts`, `spawnQueue/{types,config,accounting,state,drain,poll}.ts`,
> `spawnQueue/CLAUDE.md`, `taskSpawnEvents.ts`, `routes/tasks/{queuedSpawn,resumeTask}.ts`,
> `recovery/queuedRunResume.ts`, `__tests__/spawnQueueAccounting.test.ts`.
> Modified backend: `terminalConfig.ts`, `terminal/createSession.ts`,
> `terminalServer/routes.ts`, `terminalServerClient.ts`, `terminalProxy.ts`,
> `routes/tasks/{harnessFactory,startTask,runRoute,resumeRoute,crudHandlers}.ts`,
> `taskCache/types.ts`, `ws/endpoints/tasks.ts`, `recovery/index.ts`,
> `server/startup.ts`.
> Modified frontend: `api/{tasks.ts,types/tasks.ts}`,
> `components/taskboard/{TaskCard,TaskBoardLauncher}.tsx`,
> `components/taskboard/hooks/{useTaskLifecycleActions,useTaskActions,useTaskList,useTaskBoardState}.ts`,
> `styles/taskboard/cards.css`.
>
> ### Phase 3 — files delivered

> New: `backend/src/globalSettings.ts`, `backend/src/routes/globalSettings.ts`,
> `frontend/src/api/globalSettings.ts`, `frontend/src/components/settings/AgentsTab.tsx`.
> Modified backend: `spawnQueue.ts` (`setSpawnQueueSoftCap`, boot reads global
> settings), `spawnQueue/{accounting,state}.ts` (mutable softCap),
> `server/app.ts`, `routes/tasks/{queuedSpawn,crud,crudHandlers}.ts`
> (`dequeueTaskRun` + `POST /api/tasks/:id/cancel-queued-run`).
> Modified frontend: `api/{index,tasks}.ts`, `components/SettingsDialog.tsx`,
> `components/taskboard/{TaskCard,Lane,TaskBoardLauncher}.tsx`,
> `components/taskboard/hooks/useTaskLifecycleActions.ts`,
> `styles/taskboard/{cards,shell}.css`.
>
> ### Still not done
>
> - The fake-terminal-server **integration test** (§12) — the accounting
>   unit tests cover the race-prone core; the drain/poll glue is straightforward.

---

## 1. Goal & guarantee

When concurrent agent spawns would exceed a configurable limit, **defer** them
instead of failing. Hard guarantee after Phase 1: a requested task run is never
dropped — it either runs now or waits in a durable queue and runs when a slot
frees, surviving a backend restart.

## 2. Why a new layer (not just a bigger cap)

The session cap lives in the **terminal-server** (`terminal/createSession.ts`)
and is a hard *rejection*. The **backend** reaches it over HTTP via
`proxyCreateSession`. Seven backend call sites spawn agents through that proxy:

| Site | File | Today on cap failure |
|---|---|---|
| task run / resume | `routes/tasks/harnessFactory.ts:60` | logs, returns no `serverId` |
| workflow step | `workflowRuns/stepSpawner.ts:88` | step run **errors out** |
| merge-run resolver | `mergeRuns/resolverSpawn.ts:41` | task errored, run may **halt** |
| manual-merge resolver | `routes/tasks/mergeResponses.ts:22` | resolver never spawns |
| post-merge hook | `postMergeHooks/session.ts:138` | hook gate degraded |
| push run | `pushRuns/session.ts:53` | push fails |
| prompt customization | `workflowPromptCustomizations/sessionStarter.ts:22` | fails |

The queue is a **backend-side admission controller** that fronts all seven. The
terminal-server hard cap stays as a pure runaway backstop.

## 3. Design — thunk-based admission queue

A spawn cannot be gated at the `proxyCreateSession` call alone: a task's
worktree setup (`startTaskById` → `setupTaskWorktree`, heavy git + file copy)
happens *before* that call. Gating only the pty would let "Run All" on 100
tasks create 100 worktrees up front. So the queue defers the **whole spawn
unit** as a thunk.

```
enqueueSpawn({ kind, priority, dedupeKey, thunk }) -> { position, done: Promise<Result> }
```

- `thunk` — an async fn doing the *full* spawn (setup + exactly one
  `proxyCreateSession`). For a task run, the thunk body is today's
  `startTaskById`. For a workflow step, it is `spawnWorkflowStep`.
- The queue invokes the thunk only when there is headroom. One admitted
  thunk = one pty session = one slot.
- `done` resolves with the thunk's result. HTTP routes ignore it (delivery is
  via WS); the merge-run worker `await`s it (it is a blocking sequential loop).
- Generic — the queue knows nothing about tasks vs workflows.

## 4. Concurrency accounting (the robustness core)

The terminal-server is the single source of truth for live session count
(`GET /sessions` → `listSessions().length`, already exposed). The queue
maintains:

- `liveCount` — last authoritative count from a `GET /sessions` poll.
- `reserved[]` — one entry per admitted-but-not-yet-poll-confirmed spawn; each
  entry tracks `admittedAt`, `status: 'spawning' | 'spawned'`, `resolvedAt?`.
- **effectiveLive = `liveCount + reserved.length`**.

**Headroom bands:**
- `batch` (task run/resume, workflow step): admit while
  `effectiveLive < softCap`.
- `priority` (resolvers, post-merge hook) and `interactive` (push,
  prompt-customization): admit while `effectiveLive < softCap + PRIORITY_RESERVE`.

This guarantees an in-flight merge can always get its resolver even when
`softCap` batch slots are full.

**Poll reconciliation (the precise part).** A poll request is sent at `Treq`;
on its response, set `liveCount = polledCount`, then drop from `reserved` every
entry with `status === 'spawned' && resolvedAt < Treq` — those sessions are
definitely included in `polledCount`. Entries still `spawning`, or that
resolved after `Treq`, stay reserved. This is race-free against spawns landing
mid-poll.

**Self-correcting backstop.** If accounting still drifts and the queue
over-admits, the terminal-server hard cap rejects the extra spawn.
`proxyCreateSession` will surface a **distinguishable cap error** (new:
terminal-server returns `{ error, code: 'CAP' }`; `createSession.ts` tags it).
The queue treats a `CAP` error as "no slot" — re-enqueues the item at the front
of its band and backs the drain off one poll cycle. **No spawn is ever lost to
an accounting bug.**

**Poll-failure handling.** Add `proxyCountSessions(): Promise<number | null>`
to `terminalServerClient.ts` (returns `null` on terminal-server unreachable —
distinct from a real `0`). On `null`, the queue keeps the last `liveCount` and
**does not admit** until a poll succeeds.

## 5. The queue module

Mirror the `mergeRuns.ts` + `mergeRuns/` facade-plus-split convention:

- `backend/src/spawnQueue.ts` — facade: `enqueueSpawn`, `cancelSpawn(dedupeKey)`,
  `notifySessionsFreed()`, `getSpawnQueueSnapshot()`, `startSpawnQueue()`.
- `spawnQueue/types.ts` — `SpawnRequest`, `SpawnPriority`, `SpawnResult`.
- `spawnQueue/accounting.ts` — **pure** headroom/reconciliation logic (no I/O).
  Testable in isolation, same philosophy as `queueScheduler.ts`.
- `spawnQueue/state.ts` — pending list, `reserved[]`, dedupe index,
  cancellation.
- `spawnQueue/drain.ts` — `drain()`: non-reentrant (an `isDraining` flag with a
  `drainAgain` re-check); admits highest-band, oldest-`enqueuedAt` first while
  headroom > 0.
- `spawnQueue/poll.ts` — the `GET /sessions` poll loop; runs **only** while
  `pending.length > 0 || reserved.length > 0` (zero idle cost), ~1.5 s interval.
- `spawnQueue/CLAUDE.md` — document the contract.

**Drain triggers:** on `enqueueSpawn`; on each successful poll; on
`notifySessionsFreed()` (called right after the backend's own kills — see §8)
so a finished task's slot is reused within milliseconds rather than waiting for
the next poll.

## 6. Task model & restart durability

- `taskCache/types.ts` — add `runQueued?: boolean` and `runQueuedAt?: number`
  to `Task`. Status stays `open` while queued (no new lane, no migration, no
  drag-drop changes — lighter and lower-risk than a new `queued` status; the
  card just renders a "Queued" badge).
- `/api/tasks/:id/run`: validate `open`; if not already queued, set
  `runQueued: true` + `runQueuedAt`, then
  `enqueueSpawn({ kind:'task-run', priority:'batch', dedupeKey:'task-run:'+id, thunk: () => startTaskById(...) })`.
  The thunk flips status to `in_progress` and clears `runQueued` when admitted.
- **Boot recovery** — new `recovery/queuedRunResume.ts`, registered as a phase
  in `recovery/index.ts`: scan loaded projects for
  `status==='open' && runQueued` and re-`enqueueSpawn` each.
  `setupTaskWorktree`'s existing `reconcileStaleState` makes a re-run
  idempotent against a half-created worktree from a crash mid-thunk.
- `DELETE /api/tasks/:id` (`routes/tasks/crudHandlers.ts`): also
  `cancelSpawn('task-run:'+id)` and clear the flag.
- `startSpawnQueue()` wired into `server/startup.ts`; the resume phase runs
  alongside the existing recovery sweep.

## 7. Delivering the terminal to the frontend

Today `/run` returns `serverId` synchronously and `runTask` calls
`addTerminal`. A queued task has no `serverId` at HTTP-response time, so:

- `/run` and `/resume` responses change to `{ accepted: true, queued: boolean }`
  (coordinated FE+BE change — `RunTaskResult` type updates).
- The task thunk, after a successful spawn, emits a new `/ws/tasks` event
  `{ type:'task-spawned', taskId, serverId, command, worktreePath }` (add to
  `ws/endpoints/tasks.ts`) — mirroring the existing workflow `step-spawned`
  pattern.
- Frontend `subscribeTasks` (`api/tasks.ts`) + `useTaskList.ts` gain a
  `task-spawned` branch that calls `addTerminal({...})`.
  `useTaskLifecycleActions.runTask` no longer mounts a terminal from the HTTP
  response.
- **All** task runs route through the queue (immediate admit when headroom
  exists) — one uniform path, no dual code path. Multi-tab behavior matches
  workflows (every tab watching the project mounts the terminal — already the
  accepted model for `step-spawned`).
- `runAllOpen` (`useTaskLifecycleActions.ts:47`) drops its sequential `await`
  loop — it can enqueue every open task at once. The "sequentially to avoid
  hammering git" concern is now solved properly: worktree setup happens inside
  thunks, paced by the drain.

**Known gap (Phase 2 fix):** if every browser tab is closed when a queued task
is admitted, the `task-spawned` event is missed — the *work still runs and
completes*, but that tab can't auto-mount the terminal. Phase 2 closes this
with cwd-based reattach (§11). Phase 1 still fully satisfies "don't lose
tasks" — only live *viewing* is affected.

## 8. Remaining six spawn sites

Each wraps its `proxyCreateSession` (or its whole spawn helper) in
`enqueueSpawn` with a priority:

- **Workflow step** — `workflowRuns` advance logic `await`s
  `enqueueSpawn({ kind:'workflow-step', priority:'batch', dedupeKey:'wf-step:'+runId+':'+stepIndex, thunk: spawnWorkflowStep })`.
  The run snapshot gains a "step queued" state; `step-spawned` already fires
  inside the thunk so it naturally fires only on admission.
- **Merge-run / manual-merge resolvers, post-merge hook** — `priority` band.
  The merge worker is already a blocking sequential loop, so `await done` is
  fine; resolvers almost never queue (reserve band). Existing genuine
  "terminal-server down" handling stays.
- **Push run, prompt customization** — `interactive` band.
- `notifySessionsFreed()` is called after the backend's own kills
  (`routes/tasks/hooks.ts:126`, `worktree/cleanup.ts:52`, `pushRuns/cleanup.ts`)
  for low-latency drain.
- Cancellation: workflow-run cancel and merge-run cancel call
  `cancelSpawn(dedupeKey)` for any still-pending step/resolver.

## 9. Hard cap & settings

- `terminalConfig.ts` — raise `MAX_TERMINAL_SESSIONS` to a generous backstop
  (>= `softCap + PRIORITY_RESERVE + manual-terminal headroom`; e.g. 200) and
  rewrite the comment: it is now a runaway guard only; the queue's `softCap` is
  the real governor.
- **softCap is machine-global** (one backend, one terminal-server, one
  machine's RAM) — `UserSettings` is per-project and wrong for this. Phase 1: a
  constant with env override `LATTICE_MAX_CONCURRENT_AGENTS`. Phase 3:
  `~/.lattice/globalSettings.json` + `GET/PATCH /api/global-settings` + a
  SettingsDialog field.
- Manual WS terminals (new-shell tray, startup terminals) are intentionally
  **not** queued — interactive, single, user-paced; they live in the headroom
  between `softCap+RESERVE` and the hard cap.

## 10. Robustness / failure-mode checklist

- **Over-admit** → hard-cap `CAP` error → re-enqueue at band front + back off.
  No loss.
- **Terminal-server down** → poll returns `null` → freeze admissions, keep last
  count; `proxyCreateSession`'s existing respawn retry covers transient cases;
  persistent failure surfaces as a queued (not failed) task.
- **Backend restart** → in-memory queue lost; `runQueued` flag + boot reconcile
  rebuilds task entries; workflow/merge runs rebuild via their existing resume
  logic.
- **Reentrant drain** → `isDraining`/`drainAgain` guard.
- **Duplicate enqueue** (double-click, retry) → `dedupeKey` makes it a no-op
  returning the existing position.
- **Thunk throws before `proxyCreateSession`** (worktree setup fails) →
  reservation released, caller's `done` rejects, error logged — same surface as
  today.
- **Crash mid-thunk** → half-created worktree reconciled by
  `reconcileStaleState` on the boot re-run.
- **Starvation** → priority bands are low-volume and bounded; batch always
  drains behind them.
- **Cancellation race** (admitted between `cancelSpawn` and drain) →
  `cancelSpawn` only removes *pending* items; an already-admitted spawn
  completes and is cleaned up by the normal task-delete path.

## 11. Phasing

- **Phase 1 — Core queue + task runs (delivers the guarantee). ✅ DONE
  (2026-05-21).** `spawnQueue` module + pure accounting + poll/drain +
  `CAP`-requeue; route task run/resume; `runQueued` flag + boot reconcile;
  `/run` `/resume` response change + `task-spawned` event + frontend wiring +
  queued badge; hard-cap raise; `softCap` constant. Unit tests for
  `accounting.ts`. **Independently shippable.**
- **Phase 2 — Remaining sites + robustness. ✅ DONE (2026-05-21).** Queued
  workflow steps (fire-and-forget, `batch`), all resolvers + post-merge hook
  (`priority`), push + prompt-customization (`interactive`);
  `notifySessionsFreed` wired at the three kill sites (does an out-of-band
  poll so a freed slot is reused immediately); `GET /api/spawn-queue` debug
  route; frontend cwd-based terminal reattach (`useTaskTerminalReattach`)
  closes the §7 gap. New shared helper `queuedCreateSession` for await-style
  spawn sites.

  ### Phase 2 — files delivered

  New: `queuedCreateSession.ts`,
  `components/taskboard/hooks/useTaskTerminalReattach.ts`.
  Modified backend: `workflowRuns/stepSpawner.ts`, `mergeRuns/resolverSpawn.ts`,
  `routes/tasks/mergeResponses.ts`, `postMergeHooks/session.ts`,
  `pushRuns/session.ts`, `workflowPromptCustomizations/sessionStarter.ts`,
  `routes/tasks/hooks.ts`, `worktree/cleanup.ts`, `pushRuns/cleanup.ts`,
  `routes/terminals.ts`, `spawnQueue.ts`, `spawnQueue/poll.ts` (`pokePoll`).
  Modified frontend: `components/taskboard/TaskBoardLauncher.tsx`.

  ### Phase 2 — deliberate scope calls

  - **`cancelSpawn` on workflow-run / merge-run cancel: NOT wired.** §11
    Phase 2 does not list it (only §8's prose mentions it). A queued workflow
    step / resolver admits fast and a spawned-but-cancelled terminal is
    benign (a resolver is a real conflict the user may still want). Wiring it
    would mean making the workflow/merge engines tolerate a thrown `done`
    rejection — touching core error paths for marginal benefit. Task-delete
    `cancelSpawn` (Phase 1) remains wired. The `cancelSpawn` facade exists if
    a future need arises.
  - Workflow steps enqueue **fire-and-forget** (not awaited): the advance
    logic returns immediately; `step-spawned` (already consumed by the
    frontend) fires from inside the thunk on admission — same model as task
    runs. Resolvers/hook/push/prompt-customization **await** the queue
    because their caller needs the session result.
- **Phase 3 — UI & tuning. ✅ DONE (2026-05-21).** `~/.lattice/globalSettings.json`
  + `GET/PATCH /api/global-settings` + a SettingsDialog "Agents" tab with the
  `maxConcurrentAgents` control (applies live — no restart); "N running ·
  M queued" taskboard footer indicator; cancel-queued affordance (a Ban
  button on queued cards → `POST /api/tasks/:id/cancel-queued-run`).

## 12. Testing

- `backend/src/__tests__/spawnQueueAccounting.test.ts` — pure unit tests on
  `accounting.ts`: headroom per band, poll reconciliation across the mid-poll
  race, `CAP`-requeue, priority ordering, dedupe. No I/O, mirrors
  `queueScheduler.test.ts` / `mergeRunState.test.ts`.
- Integration: a fake terminal-server (or stubbed
  `proxyCreateSession`/`proxyCountSessions`) driving a Run-All of N > softCap
  tasks; assert exactly `softCap` concurrent, all N eventually spawned, none
  lost; assert restart mid-drain re-enqueues via the boot phase.
- `backend/`: `npx tsc --noEmit` + `npm test`. `frontend/`: `npx tsc -b`.

## 13. Files touched (summary)

**New:** `spawnQueue.ts`, `spawnQueue/{types,state,accounting,drain,poll}.ts`,
`spawnQueue/CLAUDE.md`, `recovery/queuedRunResume.ts`,
`__tests__/spawnQueueAccounting.test.ts`; (Phase 3) `globalSettings.ts`,
`routes/globalSettings.ts`, `frontend/src/api/globalSettings.ts`.

**Modified backend:** `terminalConfig.ts`, `terminal/createSession.ts` (CAP
code), `terminalServerClient.ts` (`proxyCountSessions`, CAP code),
`routes/tasks/{runRoute,resumeRoute,crudHandlers}.ts`,
`routes/tasks/mergeResponses.ts`, `workflowRuns.ts` +
`workflowRuns/stepSpawner.ts`, `mergeRuns/resolverSpawn.ts`,
`postMergeHooks/session.ts`, `pushRuns/session.ts`,
`workflowPromptCustomizations/sessionStarter.ts`, `taskCache/types.ts`,
`ws/endpoints/tasks.ts`, `recovery/index.ts`, `server/startup.ts`, kill sites
for `notifySessionsFreed`.

**Modified frontend:** `api/tasks.ts`, `api/types/tasks.ts`,
`components/taskboard/hooks/{useTaskLifecycleActions,useTaskList}.ts`,
`components/taskboard/TaskCard.tsx`; (Phase 3) `SettingsDialog` + lane header.

---

## Appendix — related context

- **Option 3 (already implemented):** `backend/src/terminal/launchContext.ts`
  now sets `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`,
  `DISABLE_ERROR_REPORTING`, `DISABLE_NON_ESSENTIAL_MODEL_CALLS` as defaults on
  every spawned pty.
- **Option 2 (planned, separate):** spawn `claude` directly instead of via a
  shell. Feasible on this machine — native `claude.exe` at
  `C:\Users\spenc\.local\bin\claude.exe`. `pi`/`codex` are npm `.cmd` shims and
  keep the shell path. Modest win (removes one `cmd.exe` per task); not part of
  this queue plan.
- **Option 1 (deferred):** headless `claude -p` execution mode — the larger
  lever for raising the real concurrency ceiling. Out of scope here.
