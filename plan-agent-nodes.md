# Plan: Claude agent nodes + focus beams + worktree highlight

Visualize in-progress Claude agents on the 3D graph: a free-floating
filled disc ("Claude node") per running worktree agent, color-coded to the
task, with live beams to the file(s) it is currently reading/modifying.
Plus a `W` hotkey that outlines every file modified by a not-yet-merged
task. **Claude harness only for now** — Codex/Pi are a documented follow-up
(see "Later" at the bottom).

Status: **implemented; awaiting live manual verification.**
`[ ]` pending · `[~]` in progress · `[x]` done.

## Decisions (confirmed)

- **Beams:** TTL fade, multiple concurrent. Each Read/Edit/Write tool-use
  opens a beam (~2.6 s TTL) that fades out; several files lit at once.
  PostToolUse collapses the remaining TTL to a quick (~0.7 s) fade.
- **Claude node:** filled task-colored disc + soft outer glow.
- **Task colors:** backend-assigned **persistent palette slot**
  (`Task.colorIndex` = smallest index free among active tasks) → golden-angle
  palette on the frontend. Guaranteed-distinct for 30–80 agents, never
  reshuffles when a sibling finishes. (Superseded the original id-hash idea
  per user: fleets run up to 84 agents.)
- **`W`:** hold-to-highlight (like `h`/`z`), not sticky.
- **Claude node is a custom `graph.scene()` object**, not a `graphData`
  node — no sim reheat on agent start/stop, no DAG distortion. It eases
  toward its target instead of repelling file nodes.

## Part A — Per-task colors ✅

- [x] `frontend/src/taskColors.ts` — `taskColor(task)` / `colorForIndex(i)` /
  `taskColorIndex(task)`. Golden-angle hue × 3 S/L bands, keyed by
  `colorIndex` (fallback: id hash). Single source of truth.
- [x] `taskboard/TaskCard.tsx` — `in_progress`/`ready_to_merge` cards set
  `--task-color` + `has-task-accent` class.
- [x] `styles/taskboard/cards.css` — `.has-task-accent` left-edge accent
  (`.selected`/`.conflict` still override via their `!important`).

## Part B — Persist harness + color slot ✅

- [x] `backend/src/taskCache/types.ts` — `harness?` + `colorIndex?`.
- [x] `frontend/src/api/types/tasks.ts` — mirror both.
- [x] `backend/src/routes/tasks/colorSlot.ts` (new) — `assignColorSlot(tasks,
  selfId)`; covered by `__tests__/colorSlot.test.ts` (4 cases).
- [x] `backend/src/routes/tasks/startTask.ts` — assign slot + write harness on
  the in_progress flip (keeps an existing slot on re-run).

## Part C — Live activity via Claude hooks ✅

- [x] `backend/src/claudeStopHook.ts` — `renderClaudeHooksConfig({completeUrl,
  activityUrl})` adds `PreToolUse`+`PostToolUse` (`matcher:
  Read|Edit|Write|MultiEdit|NotebookEdit`, `curl -s -m 2 … -d @-`). No `-o
  /dev/null` (Windows curl can't open it; endpoint is 204 so `-s` is clean).
- [x] `backend/src/worktree/stopHook.ts` — `installStopHook` writes both hooks;
  `renderStopHookJson` (repair path) matches. **As-built:** hooks are
  installed for *every* worktree (`.claude/` is Claude-only anyway, so it's a
  no-op for Pi/Codex primaries and a bonus for Claude resolvers) — so
  `installStopHook`'s `merge.ts` caller didn't need a harness param. The
  Claude-only *scoping* is enforced on the frontend.
- [x] `backend/src/taskActivityEvents.ts` (new) — pub/sub.
- [x] `backend/src/routes/tasks/activity.ts` (new) — `POST /activity` (maps
  worktree→project path via `path.relative`, drops escapes + managed files,
  emits the event) **and** `GET /worktree-modified` (Part E). Mounted before
  crud in `routes/tasks.ts` so `worktree-modified` isn't captured as `:id`.
- [x] `backend/src/ws/endpoints/tasks.ts` — fan out `task-activity`.
- [x] `backend/src/server/app.ts` — json limit → 25 mb (large `Write` bodies).
- [x] `frontend/src/api/tasks.ts` — `subscribeTasks(…, onActivity?)` +
  `fetchWorktreeModified`; types in `api/types/tasks.ts`.

## Part D — Graph overlay: Claude nodes + beams ✅

- [x] `forceGraph/claudeNodeSprite.ts` (new) — `makeClaudeNode(color, size)`,
  filled disc + glow, per-color material cache.
- [x] `forceGraph/agentOverlay.ts` (new) — `AgentOverlay` group in
  `graph.scene()`. Per agent: node + TTL beams. `tick()` eases node toward
  active-file centroid (parked orbit slot when idle), updates beam endpoints
  + opacity, prunes expired. Path→node index rebuilt only on structural
  `graphData` swap.
- [x] `forceGraph/hooks/useAgentOverlay.ts` (new) — own `/ws/tasks` sub
  (Claude + in_progress), overlay lifecycle, RAF loop, holds the idle
  `agents` reason while active.
- [x] `forceGraph/idleController.ts` — added the `agents` reason
  (`acquireAgents`/`releaseAgents`).
- [x] `forceGraph/ForceGraphView.tsx` — wired `useAgentOverlay`.

## Part E — `W` hotkey: worktree outline ✅

- [x] `GET /api/tasks/worktree-modified` (in `activity.ts`) — per active task,
  read-only worktree git (`diff --name-only <base>...HEAD` + `status
  --porcelain`), base branch resolved via `rev-parse --abbrev-ref HEAD` on
  the project repo. Returns `[{taskId, colorIndex, files}]`.
- [x] `forceGraph/worktreeRing.ts` (new) — `setNodeWorktreeRing(root, on,
  color, baseSize)`, double concentric ring per task color.
- [x] `forceGraph/hooks/useWorktreeHighlight.ts` (new) — `W` hold (blur/
  visibilitychange resets, `isTextInput` guard). Fetches on press, rings
  matching nodes, strips on release. **As-built:** single fetch per press
  (momentary), not a live re-sync — re-press to refresh (keeps 80×git off
  the hot path).
- [x] `forceGraph/ForceGraphView.tsx` — wired `useWorktreeHighlight`.

## Part F — Docs ✅

- [x] Root `CLAUDE.md` (HTTP/WS table + conventions), `backend/src/CLAUDE.md`,
  `backend/src/routes/CLAUDE.md`, `forceGraph/CLAUDE.md`.

## Verification

- [x] backend `npx tsc --noEmit` ✅
- [x] frontend `npx tsc -b` ✅
- [x] backend `npm test` → 141/141 ✅ · frontend `npm test` → 52/52 ✅
- [ ] **Manual (user):** run a Claude task; confirm the disc appears, beams
  light on reads/edits and fade, and hold `W` to see the unmerged-modified
  outlines. Watch idle CPU returns to ~0 once agents finish (the `agents`
  idle reason releases).

## Known tradeoffs / follow-ups

- The `agents` idle reason keeps the RAF render loop running while any agent
  node is on screen — a deliberate, scoped cost (released the moment no
  agents remain). Counter to the `plan.md` idle work, but required for the
  easing + beam fades to paint.
- PreToolUse adds up to `-m 2` s latency per tool call **only if the backend
  is unreachable**; sub-ms when it's up.
- `W` is a momentary git snapshot per press (no live refresh while held).

## Part G — Orange nodes for non-worktree Claude sessions ✅

Added per user follow-up: a Claude-orange node (+ same beams) for every
Claude session that runs OUTSIDE a git worktree (push runs, workflow steps,
post-merge hooks). All the same color (`CLAUDE_ORANGE`) since they have no
task color. Prompt-customization sessions are intentionally skipped (they
only edit a scratch prompt file — no project-file activity).

Design: **stateless token-keyed activity + a presence registry.**
- [x] `backend/src/agentActivity.ts` (new) — `encodeAgentToken`/`decode`/
  `buildAgentActivityUrl` (base64url, shell-safe, no `&`) + `AgentActivityEvent`
  pub/sub. Token carries agent id + project + label, so the activity route is
  stateless. Tested (`__tests__/agentActivity.test.ts`).
- [x] `backend/src/agentSessions.ts` (new) — presence registry: register at
  spawn, unregister at completion callback, per-project snapshot pub/sub +
  lazy 30-min safety sweep for abnormal exits.
- [x] `backend/src/claudeHookBody.ts` (new) — shared PreToolUse/PostToolUse
  body parsing (file/phase/tool/cwd); task `activity.ts` refactored onto it.
- [x] `backend/src/routes/agentActivity.ts` (new) — `POST /api/agent-activity/
  :token`; maps file→project (under the token's project root) and emits.
  Mounted in `server/app.ts`.
- [x] `backend/src/ws/endpoints/agentSessions.ts` (new) — `/ws/agent-sessions`
  presence snapshot (via `buildProjectSnapshotWss`); registered in `wsServer.ts`.
  `agent-activity` fanned out on `/ws/tasks`.
- [x] Spawn sites install activity hooks + register/unregister presence
  (Claude-only — Pi/codex get no node):
  - push: `pushRuns/stopHook.ts` + `session.ts`; unregister in
    `routes/pushRuns.ts` `/done`.
  - post-merge: `postMergeHooks/stopHook.ts` + `session.ts`; unregister in
    `routes/postMergeHooks.ts` `/complete` + `/abort`.
  - workflow step: `workflowRuns/stepSpawner.ts`; unregister in
    `routes/workflows.ts` step `/complete`.
- [x] Frontend: `CLAUDE_ORANGE` in `taskColors.ts`; `AgentActivityEvent` +
  `AgentSession` types; `subscribeTasks(…, onAgentActivity)` +
  `subscribeAgentSessions`; `useAgentOverlay` merges task + session
  descriptors into the one `AgentOverlay` (no overlay changes needed — it's
  keyed by string id).

Verification: backend `tsc` ✅ + `npm test` 144/144 ✅; frontend `tsc -b` ✅ +
`npm test` 52/52 ✅.

Known limitations: presence is registry-driven off completion callbacks (very
reliable — triple-backstopped); an abnormal exit lingers until the 30-min
safety sweep. A pure-git push run (no file Reads/Edits) shows the node but no
beams (correct — it touches no project files). Manual user-launched `claude`
shells aren't instrumented (Lattice installs no hooks there).

## Later (Codex / Pi)

- Codex/Pi have no Claude-style PreToolUse/PostToolUse hooks. The Claude
  node + `W` rings work off git/task state already, so `W` extends to all
  harnesses for free (drop the `harness === 'claude'` filter when ready).
  Live beams need a per-harness activity source (Pi extension event, Codex
  equivalent) POSTing the same `/activity` shape — only the producer
  changes; `TaskActivityEvent` is already harness-agnostic.
