# Lattice

Personal coding orchestrator. Manages parallel Claude Code agents in
git-worktree branches and visualizes a project's source tree as a 3D
force-directed DAG.

## Layout

- `backend/` — TypeScript Node.js Express server (`:5184`)
- `frontend/` — Vite + React + TS + xterm + 3d-force-graph (`:5183`)
- `package.json` (root) — `concurrently` runs both via `npm run dev`
- `<project>/.lattice/` — per-project scratch (gitignored): `workflow-steps/`, `workflows.json`, `userSettings.json`, `health-cache.json`. **No longer holds `worktrees/` or push-run scratch** — those moved to home-scoped locations (see below). Tasks live in `~/.lattice/per-project/<hash>/tasks.json`.
- `~/.lattice/projects.json` — global index of projects with Lattice tasks
- `~/.lattice/per-project/<sha1(path)[:12]>/tasks.json` — task DB per project. Moved out of `<project>/.lattice/tasks.json` after the 2026-05-09 catastrophic-deletion incident; legacy in-project files auto-migrate on first read. `run.lock` here is the cross-process per-project merge lock.
- `~/.lattice/per-project/<sha1(path)[:12]>/push/<id>/` — per-push-run Claude scratch (`PUSH_INSTRUCTIONS.md` + Stop hook). Recursive cleanup is path-guarded to this home root and refused if it would land under the repo.
- `~/.lattice/worktrees/<projectHash>/<slug>-<id>/` — per-task git worktree checkout. **Outside the project tree on purpose** (2026-05-10): nesting them inside `<repo>/.lattice/` was the root of three `.git`-deletion incidents (a bad recursive-delete path, or `git status` enumerating the nested checkouts). The only thing left inside `<repo>/.git` is the small `worktrees/<name>/gitdir` pointer.
- `~/.lattice/snapshots/<projectHash>/<ts>-<label>/` — copy-based working-tree snapshot (replaces `git stash --include-untracked`, which had a silent-data-loss failure mode). Orphan snapshots from a crashed run are restored on next boot via `recoverPendingSnapshots`.
- `~/.lattice/git-backups/<projectHash>/<ts>.bundle` — `git bundle --all` snapshot taken before each merge run; last 5 kept. Last-resort full-history recovery if `.git` is ever damaged: `git fetch <bundle>`.
- `~/.lattice/globalSettings.json` — machine-global settings (`maxConcurrentAgents`, MCP defs/overrides, `piModelMenu`, `piProviders`).
- `~/.lattice/piManagedProviders.json` — sidecar listing the Pi provider ids Lattice manages in `~/.pi/agent/models.json`, so a UI removal deletes precisely those (hand-written providers are never touched). See `backend/src/piModels.ts` `reconcilePiModelsJson`.

### `.git`-deletion defences (read before touching the merge pipeline)

Every prior incident traced to a recursive filesystem delete reaching `.git` (directly via `fs.rm`, or via a lost `git stash --include-untracked`). Layered defences, outermost first: (1) worktrees and push-run scratch live outside the project tree; (2) `projectGit()` — all git against the project repo goes through a wrapper that whitelists subcommands (no `clean`/`stash`/`reset --hard`/`update-ref -d`/non-ff `merge`/`branch -D <non-lattice>`/`checkout <branch>`/…); (3) no raw `fs.rm` fallback in worktree cleanup — recursive removal is delegated to `git worktree remove`; (4) `pruneReparsePointsUnder` strips any junction/symlink before recursive scratch removal paths so neither git's recursion nor Lattice's `fs.rm` can walk a reparse-point loop (an in-worktree `npm install` of a `file:..` self-dep was the realistic source — and `backend`/`frontend` no longer carry that self-dep); (5) copy-based snapshots, never `git stash`; (6) a run circuit breaker that halts the whole merge run if `.git` vanishes or HEAD moves non-forward between tasks; (7) the `git bundle` backup above; (8) `assertNotReparsePoint` on the remaining `fs.rm` sites, snapshot-manifest path validation, guarded push-run cleanup, and a cross-process project run lock. See `backend/src/worktree/CLAUDE.md`.

## Run

```
npm run dev
```

**Do not start, stop, or restart the dev server yourself.** The user runs it
in their own terminal and watches the output for errors. Restarting it from
inside Claude steals their console, drops their HMR/WS connections, and
hides errors they were already debugging. Type-check via `tsc` to validate
your changes — the user will reload the running server when they're ready.

Type-check:
- backend: `cd backend && npx tsc --noEmit`
- frontend: `cd frontend && npx tsc -b`

## Git discipline

**Stay on the `main` branch unless otherwise specified.** Do work, commit,
and push on `main` by default; only switch to (or create) another branch when
the user explicitly asks for it, and switch back to `main` when that work is
done.

## Task pipeline

```
Backlog ──▶── Open ──▶── In Progress ──▶── Ready to Merge ──▶── QA ──▶── Done
                                                                       (Deleted bin)
```

- `Backlog → Open`: **Backlog** holds captured-but-not-yet-actionable
  tasks (the first board lane, no ▶ run button); **Open** is the
  ready-to-run lane. Promote with the card's "Move to Open" action or a
  drag — lanes/transitions live in
  `frontend/src/components/taskboard/{lanes,moveTargets}.ts`.
- `Open → In Progress`: ▶ button calls `POST /api/tasks/:id/run`. Backend
  creates `~/.lattice/worktrees/<projectHash>/<slug>-<id>` on branch
  `lattice/<slug>-<id>`, writes `LATTICE_TASK.md`, and installs a Claude
  Stop hook in `.claude/settings.local.json` that POSTs back to `/complete`.
  The Stop hook is always installed (a Pi/Codex task that later conflicts is
  resolved by a *Claude* resolver, which needs it). For a Pi-run task it also
  writes a `.pi/extensions/lattice-complete.ts` extension that POSTs
  `/complete` on `session_shutdown` — Pi's analogue of the Stop hook — and
  `LATTICE_TASK.md` is reworded so the model curls `/complete` itself as its
  final step (the extension is the backstop if it forgets). For a Codex task
  it also writes `.codex/hooks.json` with a `Stop` hook that curls `/complete`
  on turn completion — Codex's analogue of the Stop hook (`backend/src/codexStopHook.ts`;
  the Lattice codex command carries `--dangerously-bypass-hook-trust` so it runs
  without a per-hook trust prompt). Written under an `if-absent` policy so a repo
  that tracks its own `.codex/hooks.json` is never clobbered.
- `In Progress → Ready to Merge`: the in-worktree agent finishes; the Stop
  hook (Claude) / completion extension (Pi) / Codex `Stop` hook / explicit curl
  in `LATTICE_TASK.md` hits `POST /api/tasks/:id/complete` (idempotent — only
  flips on first call, and only when the branch has a commit).
- `Ready to Merge → QA`: ▶ button calls `POST /api/tasks/:id/merge`.
  Backend merges main INTO the branch *inside the worktree* (so main's
  working tree never has conflict markers and vite stays alive), then
  fast-forwards main on success.
  - Clean merge → status flips to `qa`, worktree + branch removed.
  - Conflict → backend writes `MERGE_INSTRUCTIONS.md` inside the worktree
    and returns `{conflict, command, cwd}`. The UI spawns a resolver
    Claude in the worktree. When that Claude finishes (commit + Stop),
    the worktree's existing Stop hook calls `/complete`, which detects
    the resolved merge and finalizes (FF main + cleanup). `/merged` and
    `/merge-aborted` are also exposed as explicit fallbacks.
- `QA → Done`: manual drag-and-drop in the UI, or "mark all QA → Done"
  button on the QA lane. **Also automatic**: when a QA-lane Playwright e2e
  session finishes and reports a *confident PASS* to
  `POST /api/qa-runs/:id/verdict` (`{verdict:"pass",confidence:"high"}`), the
  backend promotes the task qa → done. A FAIL — or a PASS the agent isn't
  confident in — leaves it in QA for a human.

### Merge runs (backend-driven "merge all")

`POST /api/merge-runs {project}` starts a backend run that iterates every
`ready_to_merge` task in `createdAt` order. The run continues past
conflicts (per-task `conflict: true` flag is set; resolver Claude is
spawned via the WS). Closing the browser tab does NOT cancel the run —
it keeps progressing on the backend; on reopen the UI re-syncs via
`GET /api/merge-runs/active?project=`. One active run per project; a
second start returns 409. Cancel via `POST /api/merge-runs/:id/cancel`.
Per-task in-process locks (`mergeLocks.ts`) prevent a manual `/merge`
click landing on the same task while the run is processing it.

The run executes *inside the backend process*. In dev that process gets
restarted by `tsc -w` + the dev runner whenever a merged task
fast-forwards `main` with a `backend/src` change — which would kill the
run. Two layers keep "merge all" a one-click operation anyway: (1)
`scripts/dev.mjs` doesn't restart the backend while a per-project
`run.lock` is held (it defers until the run finishes); (2) if a restart
happens regardless (a crash, or `dev.mjs` isn't the one running it), the
next boot's `resumeInterruptedMergeRuns` spots the stale `merge-run`
`run.lock` and starts a fresh run for whatever's still `ready_to_merge`
(re-attempts are idempotent on half-done tasks). The merge-run logic must
therefore stay safely re-runnable.

## HTTP / WS surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Liveness probe |
| GET | `/api/harnesses?refresh=1` | Detected agent CLIs (`claude` / `pi` / `codex`) for harness dropdowns |
| GET | `/api/default-root` | Default project for the UI |
| GET | `/api/scan?path=` | Recursive source-file scan, gitignore-aware |
| GET | `/api/search?project=&q=&regex=` | File-*contents* search (gitignore-aware grep); returns `{matches, scanned, truncated}` where `matches` are absolute paths == graph file-node ids. Backs the graph search bar's contents pass (filename matches are client-side). `regex=1` for raw regex, else `*`/`?` wildcards |
| GET | `/api/health/dead-code?project=` | Files the analyzer confidently flags unreachable (`{files, total, scannedAt}`); 60s-memoized scan. Backs the dead-code note in `LATTICE_TASK.md` + agent self-investigation |
| GET | `/api/git-history?path=&limit=` | Timeline scrubber history (`git log --name-status -M`) |
| GET | `/api/git-branch?path=` | Current branch label for the navbar (one-shot; the navbar itself uses the `/ws/git-branch` live stream) |
| GET | `/api/list-dir?path=` | Folder browser (folder picker) |
| POST | `/api/create-dir` | Folder picker create-directory helper `{parent, name}` |
| GET | `/api/settings?project=` | Read per-project user settings |
| PATCH | `/api/settings?project=` | Merge-update per-project user settings |
| GET | `/api/instruction-templates?project=` | Editable agent instruction templates (task/merge/QA/push/post-merge/workflow): each template's `defaultTemplate`, the project's `currentTemplate` (override-or-default), and its `{{token}}` docs. Backs Settings → Agent prompts; edits save via PATCH `/api/settings` (`instructionTemplateOverrides`) |
| GET | `/api/harness-system-prompts?project=` | Per-harness (`claude`/`codex`/`pi`) **system-prompt** editor data: each harness's read-only default overview + the project's current Append/Replace override. Backs Settings → Agent prompts ("Harness system prompts"); edits save via PATCH `/api/settings` (`harnessSystemPrompts`), injected at every spawn of that harness. See `backend/src/harnessSystemPrompts/` |
| GET | `/api/global-settings` | Read machine-global settings (`maxConcurrentAgents`, `mcpCustomServers`, `mcpBuiltinOverrides`, `piModelMenu`, `piProviders`) |
| PATCH | `/api/global-settings` | Update machine-global settings (applies the spawn-queue softCap live; carries MCP custom-server defs / built-in overrides; `piModelMenu` curates the Pi-model dropdown; `piProviders` reconciles into `~/.pi/agent/models.json`) |
| GET | `/api/pi-models` | Pi models for the harness dropdowns: full `pi --list-models` list, the curated "Pi — X" `menu` (`globalSettings.piModelMenu` or the default), and Pi's current `defaultPattern`. Machine-global; empty when `pi` isn't installed. See `backend/src/piModels.ts` |
| POST | `/api/pi-endpoints/probe` | `{baseUrl, apiKey?}` → `{models}`: GET `<baseUrl>/models` on an OpenAI-compatible server (vLLM, …) and list its model ids. Backs the Settings → Pi "Detect models" button |
| GET | `/api/mcp-catalog` | Merged MCP catalog (built-ins ⊕ overrides ⊕ custom). Definitions only — no secret values. Backs the Settings → MCP tab |
| GET | `/api/mcp-secrets` | Redacted MCP secret presence (`{redacted, hints}` — booleans + last-4 hints, never the value) |
| PATCH | `/api/mcp-secrets` | Set/clear one secret `{serverId, envVar, value}` (`value:null` clears); returns redacted. Stored in `~/.lattice/mcpSecrets.json` (`0600`), never settings files |
| GET | `/api/mcp-env-presence` | Which required MCP env vars exist in the backend's ambient env (booleans) — drives the "detected from your environment" state |
| POST | `/api/mcp/validate` | `{serverId}` — run the server's key validator (v1: Brave one-search probe); `{ok, error?}` |
| GET | `/api/mcp-import/scan?project=` | Scan other tools' MCP configs (Claude Code / Cursor / Codex / VS Code / Windsurf), secrets redacted |
| POST | `/api/mcp-import` | Apply selected imports `{ids, project?}` → add custom-server defs + store literal keys |
| GET | `/api/project-env?project=` | Auto-detected package-manager envs + the "fresh worktree, don't reinstall" notes (default + effective) |
| GET | `/api/projects` | Known project roots + hashes, for agent sanity checks |
| GET | `/api/tasks?project=&status=&format=markdown` | List tasks for a project; `format=markdown` returns a round-trippable markdown document for agent editing |
| GET | `/api/tasks/summary?project=` | Counts by task status for a project |
| GET | `/api/tasks/worktree-modified?project=` | Files changed by each not-yet-merged task (in_progress + ready_to_merge); drives the graph's `W` worktree-highlight |
| GET | `/api/tasks/:id` | Fetch a single task |
| POST | `/api/tasks` | Create `{project, title, description?}` |
| POST | `/api/tasks/batch` | Batch-create JSON tasks or `text/markdown` `# Heading` blocks — returns array |
| POST | `/api/tasks/bulk-update` | Apply multiple `{id, patch}` updates in one request |
| POST | `/api/tasks/upsert` | Upsert tasks from markdown/JSON; headings with `{id=...}` update, headings without ids create |
| POST | `/api/tasks/transition` | Bulk status transition by explicit `ids` or `{fromStatus, project}` |
| PATCH | `/api/tasks/:id` | Update `title` / `description` / `status`; accepts JSON or text/markdown description bodies |
| POST | `/api/tasks/reorder` | Persist per-lane task order `{project, status, ids}` |
| POST | `/api/tasks/:id/append-summary` | Append a markdown/plain-text summary beneath the task description |
| DELETE | `/api/tasks/:id` | Remove |
| POST | `/api/tasks/:id/cancel-queued-run` | Drop a queued run back to a plain Open task |
| POST | `/api/tasks/:id/run` | Enqueue an Open task's run on the spawn queue; returns `{accepted, queued}` (pty delivered later via the `task-spawned` WS event) |
| POST | `/api/tasks/:id/resume` | Enqueue a re-spawn in the existing worktree; returns `{accepted, queued}` |
| POST | `/api/tasks/:id/complete` | Stop-hook callback (in_progress → ready_to_merge) |
| POST | `/api/tasks/:id/activity` | Claude PreToolUse/PostToolUse hook callback — reports the file the agent is touching; emits a `task-activity` WS event for the graph focus beam. Also handles `SubagentStart`/`SubagentStop` (satellite spawn/stop, `lifecycle` events) and tags subagent tool-use with `subagentId` (204, body ignored) |
| POST | `/api/agent-activity/:token` | Same, for a Claude session OUTSIDE a worktree (push / workflow step / post-merge hook). The token encodes agent id + project + label; emits an `agent-activity` WS event. Also handles `SubagentStart`/`SubagentStop` + `subagentId`-tagged tool-use for satellites (204, body ignored) |
| POST | `/api/project-instrumentation` | Body `{project}` — install (or remove, per the `instrumentProjectClaudeSessions` setting) Lattice's activity hooks in `<project>/.claude/settings.local.json` so ANY Claude session in the project tree shows on the graph. Called on project open + when the toggle changes |
| POST | `/api/project-activity/:token` | SessionStart/SessionEnd/PreToolUse/PostToolUse (+ `SubagentStart`/`SubagentStop`) callback for a project-instrumented Claude session (any session, not just Lattice-spawned). Keyed by Claude's `session_id`; drives the orange node + beams + subagent satellites (204, body ignored) |
| POST | `/api/tasks/:id/merge` | Attempt git merge; conflict pre-creates resolver pty, returns `serverId` |
| POST | `/api/tasks/:id/merged` | Resolver-Claude callback after a successful merge |
| POST | `/api/tasks/:id/merge-aborted` | Resolver-Claude callback if it gave up |
| POST | `/api/tasks/:id/stash-resolved` | Callback after a stash/snapshot conflict resolver finishes |
| POST | `/api/merge-runs` | Body `{project}` — start a merge-all run |
| GET | `/api/merge-runs/active?project=` | Active run for a project, or `null` |
| GET | `/api/merge-runs/:id` | Run snapshot |
| POST | `/api/merge-runs/:id/cancel` | Request cancellation (run finishes current task and stops) |
| POST | `/api/merge-runs/:id/stash-resolved` | Callback after a post-run stash/snapshot conflict resolver finishes |
| GET | `/api/workflows?project=` | List workflow definitions for a project |
| POST | `/api/workflows` | Create a workflow definition |
| PATCH | `/api/workflows/:id` | Update a workflow definition |
| DELETE | `/api/workflows/:id` | Delete a workflow definition |
| POST | `/api/workflows/:id/run` | Start a workflow run (spawns step 0 terminal). `requireNoActiveRun:true` (sequential-queue dispatch) → **409** if a run is already active for the project, so the queue requeues instead of running two at once |
| POST | `/api/workflow-prompt-customizations` | Spawn selected harness to tailor a workflow step prompt |
| GET | `/api/workflow-prompt-customizations/:id` | Poll prompt-customization status/result |
| POST | `/api/workflow-prompt-customizations/:id/complete` | Harness callback with customized prompt |
| POST | `/api/workflow-runs/:runId/steps/:n/complete` | Stop-hook callback — advances to next step |
| POST | `/api/workflow-runs/:runId/cancel` | Cancel an active workflow run |
| GET | `/api/workflow-runs/active?project=` | Active workflow runs for a project |
| GET | `/api/git-check?path=` | Repo probe for the QA-lane Push button |
| POST | `/api/push-runs` | Start a one-off Claude push session |
| GET | `/api/push-runs/:id` | Push-run status poll |
| POST | `/api/push-runs/:id/done` | Push-run Stop-hook callback |
| DELETE | `/api/push-runs/:id` | Forget a completed push-run record |
| POST | `/api/qa-runs` | Start a QA e2e Playwright-Claude session for a QA-lane task |
| GET | `/api/qa-runs/:id` | QA-run status/verdict poll |
| POST | `/api/qa-runs/:id/verdict` | Structured QA verdict callback; confident PASS may promote qa → done |
| POST | `/api/qa-runs/:id/done` | QA-run Stop-hook backstop/cleanup callback |
| DELETE | `/api/qa-runs/:id` | Forget a completed QA-run record |
| GET | `/api/post-merge-hooks/active?project=` | Active or most-recent post-merge hook for UI rehydration |
| POST | `/api/post-merge-hooks/:id/complete` | Post-merge hook Stop-hook completion/error callback |
| POST | `/api/post-merge-hooks/:id/abort` | Abort an active post-merge hook |
| GET | `/api/terminals` | Debug: list active pty sessions |
| POST | `/api/terminals` | Pre-spawn a pty for a sidebar-launched harness terminal; returns its `serverId`. Routes the launch through the same spawn chokepoint (`resolveHarnessSpawnBody`) as tasks, so Codex/Pi MCP config is applied (a bare `/ws/terminal` connect would bypass it) |
| DELETE | `/api/terminals/:id` | Kill a pty session |
| GET | `/api/spawn-queue` | Debug: spawn-queue snapshot (pending/in-flight/reserved, softCap) |
| WS | `/ws/terminal?id=&cwd=&cols=&rows=&initialCommand=` | xterm proxy via node-pty (with replay) |
| WS | `/ws/tasks?project=` | Live task list updates + `task-spawned` events (a queued run's pty spawned) + `task-spawn-failed` (a deferred run/resume failed for a non-CAP reason; the UI toasts it) + `task-activity` (worktree Claude agent's current file) + `agent-activity` (non-worktree Claude session's current file) for the graph focus beams |
| WS | `/ws/agent-sessions?project=` | Presence snapshots of Claude sessions running outside a worktree (push / workflow step / post-merge hook); one orange graph node each |
| WS | `/ws/merge-runs?project=` | Run progress + per-conflict resolver spawn events |
| WS | `/ws/post-merge-hooks?project=` | Post-merge hook active/recent state updates |
| WS | `/ws/workflows?project=` | Workflow definition updates |
| WS | `/ws/workflow-runs?project=` | Workflow run lifecycle + per-step terminal spawn events |
| WS | `/ws/health?project=` | Incremental file-health updates from the watcher |
| WS | `/ws/git-branch?project=` | Current git branch of the active project, pushed on connect and on every `.git/HEAD` change (checkout) so the navbar chip updates live |
| WS | `/ws/git-status?project=` | Compact git-status *signature* (HEAD + dirty set) for the active project, pushed on connect and whenever a commit/stage/checkout or a working-tree edit changes it. The timeline scrubber re-fetches `/api/git-history` on a new signature (deduped against the one it last fetched), so the commit list + uncommitted view update live instead of only on page refresh |
| WS | `/ws/harnesses` | Harness availability snapshots/refresh notifications |

All WS endpoints share the HTTP server via a single `upgrade` dispatcher
(`noServer: true`); routing by `pathname` so multiple WSs can coexist.

## Conventions

- **No MUI.** UI is hand-written CSS in `frontend/src/index.css` plus
  `lucide-react` icons.
- **Sprite shapes/colors per file extension** are defined in
  `frontend/src/extensionStyles.ts` — single source of truth shared by the
  3D graph and the Legend overlay. To add a language, add an entry there.
- **Per-task accent colors** are in `frontend/src/taskColors.ts` (single
  source of truth: card left edge, graph Claude node, `W` worktree rings).
  Each running task gets a stable palette *slot* (`Task.colorIndex`,
  assigned at spawn by `backend/src/routes/tasks/colorSlot.ts` — smallest
  index free among active tasks) mapped through a golden-angle palette, so
  30–80 concurrent agents stay maximally distinct and colors never
  reshuffle when a sibling finishes.
- **Graph overlays (hold-key, or pin).** Momentary recolors of the file graph,
  each on the same chord pattern (keyup/blur/visibilitychange reset): **`H`** code
  health, **`Z`** lines of code, **`D`** dead code, **`W`** worktree-modified
  files, **`Alt`** name labels. An always-visible **overlay-key** (top-left,
  `frontend/src/components/forceGraph/GraphOverlayKey.tsx`) lists all five as
  toggle chips with their shortcuts — **clicking a chip pins that view** so it
  latches on without holding the key (`hooks/useOverlayPins.ts`; each overlay
  hook composes `held || pinned`), making the hidden Z/D/W/Alt views
  discoverable. While a **metric view** (`H`/`Z`/`D`) is active the graph is
  pared down to just the metric signal: ghost (deleted-file) nodes and
  metrics-ignored-ext files (`.json`, `.md`, … — see `DEFAULT_METRICS_IGNORED_EXTS`)
  are hidden and timeline change-rings are suppressed, all so the per-file
  coloring reads cleanly (`hooks/useGraphFilter.ts` + `nodeObjectFactory.ts`).
  The **`D`** dead-code view colors each file by
  reachability from detected entry points — green = reachable, red =
  dead/orphaned, grey = entry point or uncertain (asset / unsupported language /
  dynamic-only). Classification is computed in `backend/src/health/crossFile/`
  (reachability from roots, *not* `fanIn===0`) and rides on each node's
  `healthDetails.deadCode`. Extra roots for framework magic go in
  `userSettings.deadCodeEntryGlobs`. Complements (doesn't replace) the
  right-click "Find dead code" agent action. The same classification is
  exposed to agents over `GET /api/health/dead-code` (see
  `backend/src/deadCode.ts`); when it returns ≥1 confidently-dead file,
  worktree task setup injects an optional "investigate before deleting"
  note into `LATTICE_TASK.md` (reference-only, gated on count > 0).
- **Claude agent overlay (graph).** Each in-progress *Claude* task shows a
  free-floating filled "Claude node"; while its agent reads/modifies files
  (PreToolUse/PostToolUse hooks → `/activity` → `task-activity` WS) a TTL-
  fading focus beam links the node to each file node. **Subagents** (Task/Agent
  tool) the Claude spawns appear as smaller **satellite** nodes that follow the
  parent, each with its own focus beams and (off by default) an `agent_type`
  label — toggle the labels on via Graph settings → Sizes → "Subagent labels"
  (`graphSettings.showSubagentLabels`); the orbs themselves always show. Driven
  by Claude's `SubagentStart`/`SubagentStop` hooks plus the subagent's own
  tool-use hooks (which carry `agent_id`). Holding **`W`** outlines every file changed by
  a not-yet-merged task in that task's color. Claude-only for now (Codex/Pi lack
  the activity/subagent hooks). See
  `frontend/src/components/forceGraph/CLAUDE.md`.
- **Non-worktree Claude sessions** (push runs, workflow steps, post-merge
  hooks) get the *same* node + beams + subagent satellites, but a fixed
  Claude-orange (`CLAUDE_ORANGE`) since they have no task color. Presence is registry-
  driven (`backend/src/agentSessions.ts` → `/ws/agent-sessions`): a node
  appears at spawn and disappears at the session's completion callback;
  beams come from the `/api/agent-activity/:token` hook
  (`backend/src/agentActivity.ts`). Claude-only (Pi/codex sessions get no
  node).
- **Any Claude session in an opened project** (even ones Lattice didn't
  launch — a `claude` you start in your own terminal) also gets an orange
  node. On project open Lattice merges `PreToolUse`/`PostToolUse` +
  `SessionStart`/`SessionEnd` hooks into the project's own
  `.claude/settings.local.json` (`backend/src/projectClaudeHooks.ts`,
  preserving the user's config; opt-out via the
  `instrumentProjectClaudeSessions` setting). Those fire
  `/api/project-activity/:token` (`routes/projectClaude.ts`), keyed by
  Claude's `session_id`, feeding the same registry/beam path with a 5-min
  idle TTL (covers a missed `SessionEnd`). Sessions in `.lattice/` /
  `~/.lattice/` scratch are skipped (handled by their own machinery). A
  session must be (re)started to pick up newly-installed hooks.
- **MCP servers** are curated once at the Lattice level and injected into the
  **Claude, Codex, and Pi** sessions Lattice spawns. Built-in catalog is in code
  (`backend/src/mcp/catalog.ts`); definitions/overrides live in
  `globalSettings.json`, per-project on/off in `userSettings.json` — `mcpOverrides`
  (Claude) + `mcpHarnessOverrides` (Codex/Pi) + `qaPlaywright` — secrets in their
  own `0600` `~/.lattice/mcpSecrets.json`. **Everything is off by default**, with
  three independent per-harness switches per server (enabling for one harness
  never loads it into another). Injection is resolved in the backend at the spawn
  chokepoint (`resolveHarnessSpawnBody`) and applied per harness: **Claude** →
  reconcile into `projects[<cwd>].mcpServers` in `~/.claude.json` (terminal-server
  `applyClaudeProjectConfig`; a *global* enable also lands persistently in the
  user's own `projects[<projectRoot>]` entry on project open / settings save via
  `routes/projectClaude.ts`, so it reaches sidebar terminals + a hand-started
  `claude`); **Codex** → per-invocation `-c "mcp_servers.lattice_<id>={…}"`
  inline-TOML overrides on the command (`terminal/codexTrust.ts`, secrets in pty
  env by name, never `~/.codex/config.toml`); **Pi** → the third-party
  `pi-mcp-adapter` (for official Pi ≥0.74; private Lattice-owned install) loaded
  via a cwd-exact shim, reading a Lattice-written `<cwd>/.pi/mcp.json`
  (`backend/src/piMcp/`, never the user's global Pi config; HTTP-header secrets
  ride `${VAR}` refs). v1 covers Lattice-created launches only. See
  `backend/src/mcp/CLAUDE.md`.
- **Playwright has two independent toggles** (the only server with this split):
  the **Settings → MCP tab** toggle (`mcpOverrides.playwright` for Claude,
  `mcpHarnessOverrides.{codex,pi}.playwright` for the others) is *global* —
  injected into every Lattice-spawned session for the project (plus the user's
  own project-root Claude), headless by default. A single cross-harness **"Show
  browser"** switch on that row (`mcpPlaywrightHeaded`) flips it to *headed* (a
  visible window) for those sessions when you want to watch — resolved in
  `mcp/resolverPolicy.ts` (Claude) + `mcp/registry.ts` (codex/pi). The
  **QA-lane Globe/eye** buttons (`qaPlaywright`) are a *separate*
  *QA-e2e-runs-only* enable + headed/headless switch ("watch it test") that
  stays authoritative for QA runs (`mcpPlaywrightHeaded` never overrides a QA
  run); they never leak into ordinary task/sidebar sessions
  (gated on the spawn's `isQaRun`). When the QA Globe is on, the QA lane shows a
  per-task ▶ "run e2e test" button and a lane-header "run all e2e tests" button:
  each spawns a one-off QA-scoped-Playwright Claude session
  (`backend/src/qaRuns/`, mirrors `pushRuns/`) that exercises the merged task
  end-to-end, appends a human-readable PASS/FAIL verdict via `/append-summary`,
  then posts a *structured* verdict to `POST /api/qa-runs/:id/verdict`
  (`{verdict, confidence}`) — a confident PASS auto-advances the task qa → done
  (`backend/src/qaRuns/verdict.ts`); anything else leaves it in QA. See
  `backend/src/mcp/CLAUDE.md`.
- **Pi sub-agents** (`@tintinweb/pi-subagents`) are auto-installed when the
  `pi` CLI is detected, scoped to Lattice's own Pi sessions so the user's
  global pi config (`~/.pi/agent/settings.json`) is never polluted. Lattice
  installs the package once into a shared home dir
  (`~/.lattice/pi-extensions/` via `pi install npm:@tintinweb/pi-subagents -l`)
  and loads it through a tiny re-export shim
  (`.pi/extensions/lattice-subagents.ts` → `export { default } from
  "<shared entry>"`). Pi auto-discovers any `.ts` under `<cwd>/.pi/extensions/`
  but **cwd-exact** (it does not walk up), so Lattice drops the shim alongside
  the existing `lattice-complete.ts` in every Pi session cwd it creates
  (worktrees, workflow steps, post-merge, prompt-customization) **and at the
  project root**, the latter so a `pi` the user launches in the terminal panel
  (cwd = project root) also gets it. Backend: `backend/src/piSubagents.ts`
  (`ensurePiSubagentsInstalled` at boot + project open; `installPiSubagentsShim`
  is a graceful no-op until the shared install resolves). Always on when `pi`
  is present — no toggle.
- **Pi model selection.** The harness dropdowns (task board, workflow steps,
  post-merge hook) surface one "Pi — X" row per *curated* Pi model in addition
  to bare "Pi". The list is *detected*, never hardcoded: `backend/src/piModels.ts`
  parses `pi --list-models` (printed to **stderr**) and merges in the friendly
  names + custom-provider set from `~/.pi/agent/models.json`. The curated
  `menu` defaults to every models.json-declared model plus Pi's current default
  (`~/.pi/agent/settings.json` `defaultProvider`/`defaultModel`); the user
  widens it via Settings → Agents → "Pi model menu" (machine-global
  `globalSettings.piModelMenu`). Selection rides as a **second field**
  `piModel` ("provider/model") alongside the existing `harness` enum — never a
  composite — persisted on `UserSettings.piModel` (per-project default),
  `Task.piModel` (recorded at spawn so a resume reuses it), `WorkflowStep.piModel`,
  the workflow run's `piModelOverride`, and `UserSettings.postMergeHookPiModel`.
  It only takes effect when the resolved harness is `pi`; the single
  `buildPiModelFlag(piModel)` in `worktree/commands.ts` validates it against a
  safe `provider/model[:thinking]` pattern (shell-injection guard) and appends
  `--model "<piModel>"` at the four Pi spawn sites (task run/resume, workflow
  step, prompt customization, post-merge hook). Model SELECTION is per-spawn
  via the flag, never `~/.pi/agent/settings.json`.
  **Endpoint management (Settings → Pi):** OpenAI-compatible providers (vLLM,
  …) are declared in `globalSettings.piProviders` and *reconciled into*
  `~/.pi/agent/models.json` by `reconcilePiModelsJson()` (boot + after a
  global-settings PATCH that carries `piProviders`). Lattice owns exactly the
  provider ids it manages — tracked in the `~/.lattice/piManagedProviders.json`
  sidecar so a UI removal is a precise delete — and *preserves every
  hand-written provider* (and any `compat`/`headers` on a re-managed id). The
  "Detect models" button hits `POST /api/pi-endpoints/probe`. `settings.json`
  defaults are still never touched.
- **Tasks store** is in-memory keyed by project path with debounced JSON
  persistence; the global `~/.lattice/projects.json` index is consulted
  lazily so Stop-hook callbacks resolve task IDs across sessions.
- **3d-force-graph** uses OrbitControls (not Trackball) with `camera.up`
  locked to +Y and polar clamped to `[0, 0.75π]`. DAG mode `td`. Sprites
  are canvas-rendered with `tex.colorSpace = SRGBColorSpace` so colors
  match the legend exactly. Filtering goes through `nodeVisibility` /
  `linkVisibility` to keep the simulation stable.
- **Per-project filter / panel state** is persisted under
  `lattice.<thing>.<projectPath>` keys in `localStorage`.
- **Per-project user settings** (e.g., sidebar width) are stored in
  `<project>/.lattice/userSettings.json` via `GET /api/settings?project=` and
  `PATCH /api/settings?project=`. The `UserSettings` type lives in
  `backend/src/userSettings.ts`; frontend helpers are in `frontend/src/api.ts`.
- Prefer editing existing files; don't introduce new abstractions for
  one-off tweaks.
- **Terminal pty pre-spawn.** When a task/workflow/conflict spawn would
  produce a UI terminal, the backend pre-creates the pty via the
  terminal-server's `POST /sessions` and ships back a `serverId`. The
  frontend stores it on the `TerminalSpec` and lazy-mounts the
  `<TerminalPane>` only on first activation. This keeps "Run All" from
  blowing past Chrome's per-page WebGL context cap, since each xterm
  WebglAddon allocates its own context.
- **Codex trust is per terminal, not global.** The detached terminal launch
  context recognizes a Codex initial command and injects the documented
  one-shot `projects.<cwd>.trust_level='trusted'` config override through a
  child-only environment variable. Lattice-spawned Codex agents therefore skip
  the folder-trust gate without writing `~/.codex/config.toml` or changing
  Codex sessions launched outside Lattice.
- **Per-harness system-prompt overrides** let a project customize each agent's
  *own* built-in system prompt (distinct from the Lattice-authored briefs in
  `instructionTemplates/`). Two independent fields per harness — **Append**
  (added on top of the built-in prompt) and **Replace** (swaps it) — edited in
  Settings → Agent prompts and stored on `UserSettings.harnessSystemPrompts`.
  Injected at the one spawn chokepoint (`resolveHarnessSpawnBody`) per harness:
  Claude `--(append-)system-prompt-file` (scratch file + flag applied in the
  terminal-server), Codex `developer_instructions` / `model_instructions_file`
  (`-c` overrides), Pi a Lattice `before_agent_start` extension (cwd files, like
  the MCP shim). Claude's built-in prompt is proprietary so the editor shows an
  "unviewable" note (the override still works); Codex/Pi show their open-source
  defaults. Replacing is discouraged everywhere (warned in the UI). See
  `backend/src/harnessSystemPrompts/CLAUDE.md`.

## Ports

Frontend `:5183`, backend `:5184` — offset +10 from typical Vite (5173)
to avoid collisions with other local dev servers.

## Worktree paths

For a repo at `<repoRoot>` (with `<hash>` = `sha1(canonicalPath)[:12]`):

- worktree dir: `~/.lattice/worktrees/<hash>/<slug>-<shortid>` — **outside**
  the project tree (see the `.git`-deletion defences above). `git worktree
  add` records the worktree at `<repoRoot>/.git/worktrees/<name>/` regardless
  of where the checkout lives.
  - legacy: worktrees created before 2026-05-10 are at
    `<repoRoot>/.lattice/worktrees/<slug>-<shortid>`. Those keep working
    (the task record stores `worktreePath` explicitly); the boot-time
    `sweepOrphanedWorktrees` reclaims any that outlive their task.
- branch: `lattice/<slug>-<shortid>`
- task instructions inside the worktree: `LATTICE_TASK.md`
- conflict-resolver instructions inside the worktree:
  `<worktree>/MERGE_INSTRUCTIONS.md`

## Creating tasks via the API (e.g. for testing)

To seed tasks programmatically, POST to `/api/tasks`:

```bash
curl -s -X POST http://127.0.0.1:5184/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "project": "C:\\development\\lattice",
    "title": "Bump version comment to 1.0.1",
    "description": "in frontend/src/api.ts at the top of the file, add a comment `// version 1.0.1` (replacing any existing version comment)."
  }'
```

The response is the new task with its `id`. Run a task with
`POST /api/tasks/:id/run`.

### Seeding low-change / high-conflict tasks for end-to-end testing

To stress the merge pipeline, create N tasks that all touch the same one
or two lines in the same file. Each task in isolation makes a tiny edit;
when several land at the same time, every merge after the first one
conflicts on the same hunk — exercising the resolver flow at scale.

Pattern: ask each task to set the same constant to a different value at
the top of one file. Example for Lattice's own repo, all 5 modifying
`frontend/src/api.ts`:

```bash
for i in 1 2 3 4 5; do
  curl -s -X POST http://127.0.0.1:5184/api/tasks \
    -H "Content-Type: application/json" \
    -d "{
      \"project\": \"C:\\\\development\\\\lattice\",
      \"title\": \"version stamp ${i}\",
      \"description\": \"At the very top of frontend/src/api.ts, add or replace a single line that reads exactly: // lattice-test-stamp: ${i}. Do not edit anything else in the file.\"
    }"
done
```

After seeding, click "Run All" on the Open lane to spawn worktree
Claudes, then "Merge All" on Ready-to-Merge. The first merge will land
clean; subsequent ones should hit a one-line conflict on the stamp,
trigger a resolver Claude in each worktree, and (assuming the resolver
just keeps the incoming side) finalize automatically.
