# Lattice

Personal coding orchestrator. Manages parallel Claude Code agents in
git-worktree branches and visualizes a project's source tree as a 3D
force-directed DAG.

## Layout

- `backend/` — TypeScript Node.js Express server (`:5184`)
- `frontend/` — Vite + React + TS + xterm + 3d-force-graph (`:5183`)
- `package.json` (root) — `npm run dev` runs `scripts/devLoop.mjs` (preflight → `scripts/orchestrate.mjs`, which supervises both; relaunched on a dev-console soft restart)
- `<project>/.lattice/` — per-project scratch (gitignored): `workflow-steps/`, `workflows.json`, `userSettings.json`, `health-cache.json`. **No longer holds `worktrees/` or push-run scratch** — those moved to home-scoped locations (see below). Tasks live in `~/.lattice/per-project/<hash>/tasks.json`.
- `~/.lattice/projects.json` — global index of projects with Lattice tasks
- `~/.lattice/per-project/<sha1(path)[:12]>/tasks.json` — task DB per project. Moved out of `<project>/.lattice/tasks.json` after the 2026-05-09 catastrophic-deletion incident; legacy in-project files auto-migrate on first read. `run.lock` here is the cross-process per-project merge lock.
- `~/.lattice/per-project/<sha1(path)[:12]>/push/<id>/` — per-push-run Claude scratch (`PUSH_INSTRUCTIONS.md` + Stop hook). Recursive cleanup is path-guarded to this home root and refused if it would land under the repo.
- `~/.lattice/worktrees/<projectHash>/<slug>-<id>/` — per-task git worktree checkout. **Outside the project tree on purpose** (2026-05-10): nesting them inside `<repo>/.lattice/` was the root of three `.git`-deletion incidents (a bad recursive-delete path, or `git status` enumerating the nested checkouts). The only thing left inside `<repo>/.git` is the small `worktrees/<name>/gitdir` pointer.
- `~/.lattice/snapshots/<projectHash>/<ts>-<label>/` — copy-based working-tree snapshot (replaces `git stash --include-untracked`, which had a silent-data-loss failure mode). Orphan snapshots from a crashed run are restored on next boot via `recoverPendingSnapshots`. The same tree also holds `<ts>-discarded-worktree-<slug>-*/` **archives**: the uncommitted edits of a task worktree that was force-removed (a fresh Run's reconcile, the boot orphan sweep, or any `cleanupWorktreeForTask` — post-merge finalize, task delete) (payload in `files/`, manifest `_lattice-discarded-worktree.json`). Those are a keep-for-the-user copy, never auto-restored; the newest 20 per project are kept, and older ones are pruned only once past 7 days (`DISCARDED_WORKTREE_ARCHIVE_MIN_AGE_MS`), so a burst of discards never deletes an archive written minutes earlier. If the archive fails, the worktree is not removed.
- `~/.lattice/git-backups/<projectHash>/<ts>.bundle` — `git bundle --all` snapshot taken before each merge run; at most 5 and 8 GB per project (newest always kept, reused if under 10 min old, skipped when the disk can't hold one). Last-resort full-history recovery if `.git` is ever damaged: `git fetch <bundle>`.
- **Disk-space guard for worktrees** (`backend/src/worktree/diskSpace.ts`): a worktree is a full checkout (6.5 GB each on a big LFS repo) and a Ready-to-Merge task keeps its checkout until it merges. **Git LFS files are checked out as pointer stubs by default** (`backend/src/worktree/lfsMode.ts`, per-project `taskWorktreeLfsContent`, Settings → Agent prompts): the worktree's `git worktree add` / worktree-side merge / `merge --abort` and the task pty run with `GIT_LFS_SKIP_SMUDGE=1`, the brief tells the agent to `git lfs pull --include=<path>` a file it needs, and main's fast-forward still smudges real content; the estimate below counts LFS paths as ~1 KB in that mode. Before every `git worktree add` Lattice checks the checkout fits above `globalSettings.minFreeDiskGb` (default 10); if not, the run **waits in the spawn queue** (task stays Open + queued, never fails) and retries on a backoff or as soon as a worktree cleanup frees space. A disk wait also starts a merge run of the project's Ready-to-Merge tasks when nothing else is merging (`backend/src/diskPressureMerge.ts`; opt-out `globalSettings.autoMergeOnLowDisk: false`), and a pass of the **worktree residue sweep** (`backend/src/recovery/worktreeResidueSweep.ts` — also at boot and every 30 min): on Windows a `git worktree remove` stopped part-way by a locked file has already dropped the registration and `.git`, so the surviving files are reclaimed there (only unregistered, unowned, pty-free, >10-min-old direct children of a known project's `~/.lattice/worktrees/<hash>/` with no `.git`, or only a `.git` file whose `gitdir:` admin dir is gone), and cleanup deletes the task branch rather than leaking it. Free space can still run out after admission (anything else on the machine writes too — 2026-09-24 a merge run started on a full disk and left 12 of 22 worktrees half-merged), so: a **low-disk monitor** (`diskPressureMerge.ts` `startLowDiskMonitor`, once a minute) starts that same merge run whenever a project's worktree volume dips under the reserve (not under the 1 GB merge floor, and not again while the Ready-to-Merge set is unchanged since a run that moved nothing — only on a 15 min→2 h backoff); a merge refuses to start under 1 GB free (`worktree/diskFull.ts`) and a merge run **halts once** on a full-disk error instead of failing every task; and the worktree merge clears the residue a merge that died part-way leaves behind, archiving it first (`worktree/merge/mergeResidue.ts`). **Git's own auto-gc is off** for every git Lattice runs and every agent it spawns (`worktree/gitAutoGc.ts`, via `GIT_CONFIG_COUNT` env — nothing written to config): during a merge burst it repacked the 4.2 GB ody repo over and over and, on Windows, could not delete the mapped old packs — 80 GB of copies in six minutes. Instead `worktree/repoMaintenance.ts` runs once, a minute after each merge run, when the project isn't merging: it sweeps failed-repack debris (old `tmp_pack_*`/`tmp_obj_*`, `pack-*.pack` with no `.idx`) and runs a foreground `git gc --auto` only if the disk can hold another full pack copy above the reserve. The gc holds the project `run.lock` (non-lendable, label `repo-maintenance`) for its whole duration, so no merge can start beside a repack: `startMergeRun` refuses while maintenance is in flight (`isRepoMaintenanceRunning`), manual `/merge` meets the lock, and a workflow control step waits for it (`waitForRepoMaintenance`, bounded by the gc's 60-min timeout). Checkouts run at most two at a time (`worktree/checkoutGate.ts`), and beneath the `maxConcurrentAgents` ceiling a **resource governor** holds new task runs / workflow steps while system CPU is saturated or RAM is low (`backend/src/spawnQueue/resourceGovernor.ts`; opt-out `globalSettings.resourceGovernor: false`).
- `~/.lattice/logs/` — crash forensics. **Check here first when something
  died**: the backend's console output belongs to the user's terminal and the
  terminal-server is spawned `stdio: 'ignore'`, so nothing else survives.
  Newest 20 of each kept.
  - `crash-<ts>-<n>-<label>.log` — stack + the last 300 console lines, written
    synchronously by `backend/src/crashLog.ts` from the fatal handler.
  - `report.*.json` — Node's diagnostic report, for a **JS-heap OOM or a V8
    fatal error**. It is a V8 callback, so it does NOT fire for an OS-level
    fault; don't read its absence as "not a crash".
  - `live-<label>-<pid>.log` — a rolling mirror of the console ring for a
    process that is *currently running*, refreshed every couple of seconds.
    Deleted on any exit the process is alive to observe.
  - `crash-<ts>-000-<label>-nojs.log` — a `live-*.log` whose process vanished,
    promoted on the next boot. This is the **only** record of a death that runs
    no JavaScript (a hard native fault, an OS OOM-kill, a `taskkill /F`), where
    every handler-based mechanism above produces nothing at all.
  - `dev-runner.log` — each child's exit code + last output, from the dev
    orchestrator **and** from `backend/scripts/dev/` (which supervises
    `dist/index.js`, a grandchild the orchestrator never sees). Windows fault
    codes are decoded here, so `3221225477` reads as
    `0xC0000005 STATUS_ACCESS_VIOLATION`.
- `~/.lattice/per-project/<sha1(path)[:12]>/terminals.json` — the durable **terminal-tab registry** (`backend/src/terminalRegistry/`): one record per sidebar tab with its owner, original launch command, pinned harness conversation id and last pty. What "restore tabs on project open" rebuilds from after a backend restart / closed browser / `Ctrl+C` / reboot.
- `~/.lattice/per-project/<sha1(path)[:12]>/{workflow-runs,push-runs,qa-runs,post-merge-hooks}.json` — on-disk mirrors of the RUNNING workflow runs / push runs / QA e2e runs / post-merge hooks (file absent when nothing runs). Their agents' ptys survive a backend restart in the detached terminal-server; boot recovery re-adopts the records so the agents' callbacks keep working (`recovery/workflowRunResume.ts`, `recovery/oneOffRunResume.ts`).
- `~/.lattice/globalSettings.json` — machine-global settings (`maxConcurrentAgents`, MCP defs/overrides, `piModelMenu`, `piProviders`).
- `~/.lattice/piManagedProviders.json` — sidecar listing the Pi provider ids Lattice manages in `~/.pi/agent/models.json`, so a UI removal deletes precisely those (hand-written providers are never touched). See `backend/src/piModels.ts` `reconcilePiModelsJson`.
- `~/.lattice/bin/lattice-callback.cjs` + `~/.lattice/callback-outbox/` — durable completion callbacks. Every Claude/Codex Stop hook runs the script (the Pi extension does the same inline): it records the callback in the outbox, POSTs it with retries, and whatever is still undelivered — the backend was restarting after a merge — is replayed by the backend once it is back. See `backend/src/callbackOutbox/CLAUDE.md`.
- `~/.lattice/opengrep/` — the Lattice-managed Opengrep (SAST) engine (`bin/<version>/opengrep[.exe]`, downloaded at the user's click and verified against the pinned SHA-256), the fetched rule packs (`rules/<packId>/`, pinned commits, pruned to rule files; also the cwd every scan runs from so finding fingerprints are machine-stable), `downloads/` for in-flight transfers, and `state.json`. Never committed, never bundled — see `backend/src/opengrep/CLAUDE.md`.
- `~/.lattice/per-project/<sha1(path)[:12]>/opengrep/` — the project's stored scans: `<scanId>.json` (raw engine output) + `<scanId>.meta.json` (record); last 10 kept.

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

The user's dev console takes line commands (hint printed at boot): `r` =
**soft restart** (whole stack restarts from current scripts/deps; the detached
terminal-server is kept, so running agents are re-adopted, not killed), `d` =
exit keeping agents running, `i` = re-check/install deps. Ctrl+C is still the
full stop that ends every agent. A `package.json` / `package-lock.json` change
after boot (e.g. a merge) is `npm install`ed automatically per workspace
(`scripts/depsWatch.mjs`); vite restarts, the backend restarts through its
normal run.lock-deferred path. See `scripts/CLAUDE.md`.

Type-check:
- backend: `cd backend && npx tsc --noEmit`
- frontend: `cd frontend && npx tsc -b`

The backend also refuses to boot (before touching `~/.lattice`) when its code
or cwd is inside a `.lattice/worktrees/` task worktree, or when another
backend already holds its port (`backend/src/server/bootGuards.ts`; override
the worktree check with `LATTICE_ALLOW_WORKTREE_BACKEND=1` only for an instance
with its own HOME and ports).

E2E (Playwright): `npm run test:e2e` from the repo root. It never touches the
live instance: `playwright.config.ts` boots an **isolated** backend + vite +
terminal-server on `:5384`/`:5383`/`:5385` with HOME at `<tmp>/lattice-e2e-home`
(overrides: `LATTICE_E2E_{BACKEND,FRONTEND,TERMINAL}_PORT`, `LATTICE_E2E_HOME`),
from the already-built `backend/dist` (kept current by the user's `npm run dev`,
or `npm --prefix backend run build`). `LATTICE_E2E_BASE_URL` targets an existing
server instead; pointing it at the live `:5183`/`:5184` also needs
`LATTICE_E2E_ALLOW_LIVE=1`. The port overrides behind it: backend `PORT`,
`TERMINAL_PORT`, `LATTICE_FRONTEND_PORT` (origin allowlists), `LATTICE_DEFAULT_ROOT`;
vite `LATTICE_FRONTEND_PORT`, `LATTICE_BACKEND_PORT`, `LATTICE_VITE_CACHE_DIR`.

## Git discipline

**Stay on the `main` branch unless otherwise specified.** Do work, commit,
and push on `main` by default; only switch to (or create) another branch when
the user explicitly asks for it, and switch back to `main` when that work is
done.

**Exception — Lattice-spawned agents.** A task agent working in a
`~/.lattice/worktrees/…` checkout commits on its own `lattice/<slug>-<id>`
branch and never checks out, merges into, or pushes `main` — Lattice merges it.
Nor does it start the backend / `npm run dev` there. A merge-resolver or
workflow-step agent follows its brief (`MERGE_INSTRUCTIONS.md`,
`WORKFLOW_STEP.md`, …) over this section.

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
- `Open → In Progress`: ▶ button calls `POST /api/tasks/:id/run`, which
  **enqueues** the run on the spawn queue and returns `{accepted, queued}`
  right away — `accepted` means *admitted*, not *started*. The pty arrives
  later via the `task-spawned` WS event, so don't read the response as "the
  worktree exists now", and don't re-POST because nothing seems to have
  happened (`/resume` behaves identically). Once the queue admits the run the
  backend creates `~/.lattice/worktrees/<projectHash>/<slug>-<id>` on branch
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
  flips on first call, and only when the branch has a commit). The hooks
  deliver through the callback outbox, so a Stop that fires while the backend
  is restarting is replayed instead of lost (`backend/src/callbackOutbox/`).
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
`backend/scripts/dev.mjs` doesn't restart the backend while a per-project
`run.lock` is held (it defers until the run finishes, with a 15-minute
force backstop for a wedged holder — skipped while the backend reports the
run parked on a live conflict resolver / post-merge hook — and it drains the
backend before every restart, see `backend/src/restartDrain/CLAUDE.md`);
(2) if a restart
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
| GET | `/api/search?project=&q=&regex=` | File-*contents* search (gitignore-aware grep); returns `{matches, scanned, truncated}` where `matches` are absolute paths == graph file-node ids. Backs the graph search bar's contents pass (file- and folder-name matches are client-side). `regex=1` for raw regex, else `*`/`?` wildcards |
| GET | `/api/health/dead-code?project=` | Files the analyzer confidently flags unreachable (`{files, total, scannedAt}`); 60s-memoized scan. Backs the dead-code note in `LATTICE_TASK.md` + agent self-investigation |
| GET | `/api/git-history?path=&limit=` | Timeline scrubber history (`git log --name-status -M`), plus `deletedPaths` — the `git ls-files`-derived set of history paths that no longer exist, which is what the graph draws as ghost (deleted-file) nodes |
| GET | `/api/git-branch?path=` | Current branch label for the navbar (one-shot; the navbar itself uses the `/ws/git-branch` live stream) |
| GET | `/api/list-dir?path=` | Folder browser (folder picker) |
| POST | `/api/create-dir` | Folder picker create-directory helper `{parent, name}` |
| GET | `/api/settings?project=` | Read per-project user settings |
| PATCH | `/api/settings?project=` | Merge-update per-project user settings |
| GET | `/api/instruction-templates?project=` | Editable agent instruction templates (task/merge/QA/push/post-merge/workflow step/workflow Push/Run tests): each template's `defaultTemplate`, the project's `currentTemplate` (override-or-default), and its `{{token}}` docs. Backs Settings → Agent prompts; edits save via PATCH `/api/settings` (`instructionTemplateOverrides`) |
| GET | `/api/harness-system-prompts?project=` | Per-harness (`claude`/`codex`/`pi`) **system-prompt** editor data: each harness's read-only default overview + the project's current Append/Replace override. Backs Settings → Agent prompts ("Harness system prompts"); edits save via PATCH `/api/settings` (`harnessSystemPrompts`), injected at every spawn of that harness. See `backend/src/harnessSystemPrompts/` |
| GET | `/api/global-settings` | Read machine-global settings (`maxConcurrentAgents`, `mcpCustomServers`, `mcpBuiltinOverrides`, `piModelMenu`, `piProviders`) |
| PATCH | `/api/global-settings` | Update machine-global settings (applies the spawn-queue softCap live; carries MCP custom-server defs / built-in overrides; `piModelMenu` curates the Pi-model dropdown; `piProviders` reconciles into `~/.pi/agent/models.json`) |
| GET | `/api/pi-models` | Pi models for the harness dropdowns: full `pi --list-models` list, the curated "Pi — X" `menu` (`globalSettings.piModelMenu` or the default), and Pi's current `defaultPattern`. Machine-global; empty when `pi` isn't installed. See `backend/src/piModels.ts` |
| POST | `/api/pi-endpoints/probe` | `{baseUrl, apiKey?}` → `{models: [{id, contextWindow?}]}`: GET `<baseUrl>/models` on an OpenAI-compatible server (vLLM, NInfer, llama.cpp, …) and list what it serves, with the context window the server advertises. Backs the Settings → Pi "Detect models" button |
| GET | `/api/mcp-catalog` | Merged MCP catalog (built-ins ⊕ overrides ⊕ custom). Definitions only — no secret values. Backs the Settings → MCP tab |
| GET | `/api/mcp-secrets` | Redacted MCP secret presence (`{redacted, hints}` — booleans + last-4 hints, never the value) |
| PATCH | `/api/mcp-secrets` | Set/clear one secret `{serverId, envVar, value}` (`value:null` clears); returns redacted. Stored in `~/.lattice/mcpSecrets.json` (`0600`), never settings files |
| GET | `/api/mcp-env-presence` | Which required MCP env vars exist in the backend's ambient env (booleans) — drives the "detected from your environment" state |
| POST | `/api/mcp/validate` | `{serverId}` — run the server's key validator (v1: Brave one-search probe); `{ok, error?}` |
| GET | `/api/mcp-import/scan?project=` | Scan other tools' MCP configs (Claude Code / Cursor / Codex / VS Code / Windsurf), secrets redacted |
| POST | `/api/mcp-import` | Apply selected imports `{ids, project?}` → add custom-server defs + store literal keys |
| GET | `/api/opengrep/status?project=` | Opengrep (SAST) state: the resolved engine (`path` install wins over the Lattice-managed one), the pinned managed version, this machine's release asset, the running install job, each rule pack's install/licence state, and (with `project`) whether a scan is running + the last scan record. Backs Settings → Tools |
| POST | `/api/opengrep/install` | Start the managed engine install (`202 {job}`; single-flight; poll `/status`). Downloads the pinned release asset for this platform into `~/.lattice/opengrep/`, verifies its pinned SHA-256, runs `--version` once. Never runs at boot — user-clicked only |
| POST | `/api/opengrep/rules/install` | `{packId}` — fetch/update a rule pack at its pinned commit (`git fetch --depth 1`), prune non-rule + excluded-licence folders, record it (`202 {packs}`; poll `/status`). **409** `busy` while any project's scan is running (the swap must not pull a tree out from under the engine) |
| DELETE | `/api/opengrep/rules/:packId` | Remove an installed rule pack (**409** `busy` while a scan is running) |
| POST | `/api/opengrep/scan` | `{project, targets?, includeMarkdown?}` — run a scan with the project's enabled packs + `.opengrep/rules/` + extra paths; returns the scan record and the digest counts (`markdown` on request). `targets` are project-relative and confined to the project (**400** `bad-target` for `../…` or an absolute path elsewhere). **409** `busy` (one scan per project), `not-installed`, `no-rules` |
| GET | `/api/opengrep/scans?project=` | Recent scan records (last 10 kept, newest first) |
| GET | `/api/opengrep/scans/:id?project=&format=md&rule=&file=&severity=&budgetKb=&include=markdown` | One stored scan (`latest` allowed) rendered as the agent-facing digest — filtered by the project's severity floor / ignore lists, narrowed by `rule` / `file` / `severity`, under `budgetKb`. `format=md` returns text/markdown; default is the JSON envelope (+ `markdown` with `include=markdown`) |
| POST | `/api/opengrep/ignore` | `{project, ruleIds?, fingerprints?}` — append to the project's Opengrep ignore lists (`userSettings.opengrep`); additive, deduplicated, `opengrep:<fp>` spelling accepted. The one settings write a planning agent makes (via the `opengrep_ignore` MCP tool) so rule noise becomes a setting instead of a "please ignore X" ticket. Entries are removed in Settings → Tools |
| GET | `/api/project-env?project=` | Auto-detected package-manager envs + the "fresh worktree, don't reinstall" notes (default + effective) |
| GET | `/api/projects` | Known project roots + hashes, for agent sanity checks |
| POST | `/api/project-init/preview` | `{project, gitignore?}` → what a first commit would capture (`{probe, isEmpty, gitignore, generated, fileCount, byteCount, truncated, largest}`). Backs the Git Setup dialog; re-POSTed (debounced) on every `.gitignore` edit |
| POST | `/api/project-init` | `{project, gitignore?}` — `git init -b main` + starter `.gitignore` + first commit, so a non-repo folder becomes a usable Lattice project. `409 not-initable` (state ≠ `none`, or a path guard refused), `422 git-identity-missing` (git's raw stderr as `detail`), `500 git-failed`, `503 git-unavailable`. See `backend/src/projectInit/` |
| GET | `/api/tasks?project=&status=&ids=&fields=&clip=&since=&limit=&format=&confirm_large=` | List tasks — **progressive-disclosure defaults**: without `status` only the ACTIVE lanes come back (`done`/`deleted` omitted and counted in `omitted`), `fields=compact` (id/title/status/timestamps/text byte-counts) unless `fields=full`, full text clipped at `clip=500` chars (`clip=0` = unlimited; never clipped for `format=markdown`, which is round-tripped through `/upsert`), newest `limit=100` first (`0` = unlimited). `ids=` fetches specific tasks (full). `since=30d`/ISO/epoch bounds by last activity. Every envelope carries `bytes`/`approxTokens`/`hint`. A response over 256 KB is refused with **413** (`summary` + `suggestions`) unless `confirm_large=1`. The board UI passes `status=all&fields=full&clip=0&limit=0&confirm_large=1`. See `backend/src/routes/tasks/listQuery.ts` |
| GET | `/api/tasks/summary?project=` | Counts by task status (`byStatus`) plus per-lane cost (`lanes[status] = {count, bytes, approxTokens, newestActivityAt}`), whole-board `bytes`/`approxTokens`, and a `hint` naming the cheapest next call. Under 1 KB — the intended FIRST call for an agent |
| GET | `/api/tasks/search?project=&q=&status=&limit=` | Find tasks without listing the board: AND-of-terms substring match over title/description/summary (default `status=all` — history is what search is for), scored title×3, snippet ~160 chars, `limit=20` (max 200). Backs the `search_tasks` MCP tool and `create-task.cjs --find`. See `backend/src/routes/tasks/taskSearch.ts` |
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
| DELETE | `/api/tasks/:id` | Remove (tears down the worktree; its `lattice/*` branch is deleted unless it has commits not on HEAD — then it is kept and the response is `{ok: true, keptBranch: {name, unmergedCommits, hint}}`, `unmergedCommits: null` when the count failed) |
| POST | `/api/tasks/:id/cancel-queued-run` | Drop a queued run back to a plain Open task. A run already admitted (checking out) is aborted instead — it backs out before starting its agent — and the response adds `inFlight: true` |
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
| GET | `/api/merge-runs/recovery?project=` | Persisted workflow/merge recovery attempts and pause reasons |
| GET | `/api/merge-runs/:id` | Run snapshot |
| POST | `/api/merge-runs/:id/cancel` | Request cancellation (run finishes current task and stops) |
| POST | `/api/merge-runs/:id/stash-resolved` | Callback after a post-run stash/snapshot conflict resolver finishes |
| GET | `/api/workflows?project=` | List workflow definitions for a project |
| POST | `/api/workflows` | Create a workflow definition |
| PATCH | `/api/workflows/:id` | Update a workflow definition (optional `?project=` pin: 404 if the workflow belongs to another project) |
| DELETE | `/api/workflows/:id` | Delete a workflow definition (optional `?project=` pin, as PATCH) |
| POST | `/api/workflows/:id/run` | Start a workflow run (spawns step 0 terminal). One run per project: **409** (`active-run-exists`) if a run is already active, so the queue requeues and a manual ▶ Run queues behind it instead of running two at once. A legacy `requireNoActiveRun` body field is accepted and ignored |
| POST | `/api/workflow-prompt-customizations` | Spawn selected harness to tailor a workflow step prompt |
| GET | `/api/workflow-prompt-customizations/:id` | Poll prompt-customization status/result |
| POST | `/api/workflow-prompt-customizations/:id/complete` | Harness callback with customized prompt |
| POST | `/api/workflow-runs/:runId/steps/:n/complete` | Stop-hook callback — advances to next step |
| GET | `/api/workflow-runs/:runId?project=` | One run by id, incl. a recently finished one (`{run}`; 404 once forgotten / after a restart). The workflow queue asks it when a run leaves its active set with no terminal WS event, to tell "finished while disconnected" from "lost" |
| POST | `/api/workflow-runs/:runId/cancel` | Cancel an active workflow run (optional `?project=` pin: 404 if the run belongs to another project) |
| GET | `/api/workflow-runs/active?project=` | Active workflow runs for a project |
| GET | `/api/git-check?path=` | Repo probe for the QA-lane Push button (`hasGit` = `fs.stat` of `<path>/.git`, unchanged), plus an additive `git: ProjectGitProbe` (walk-up state: `repo`/`nested`/`bare`/`none`/`unavailable`/`error`) that backs the navbar's Git Setup chip |
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
| DELETE | `/api/terminals/:id` | Kill a pty session (also ends its registry tab as user-closed; if the pty belongs to a running post-merge hook, that hook is ended `aborted` so its merge run / workflow unblocks) |
| GET | `/api/terminal-tabs?project=` | The project's durable terminal-tab records (`backend/src/terminalRegistry/`), incl. ended-but-kept restore failures |
| POST | `/api/terminal-tabs/restore?project=` | Rebuild the sidebar's tabs: adopt live ptys, relaunch dead ones into their previous harness conversation; returns `{status, adopted, queued, dropped}` and streams per-tab outcomes on `/ws/terminal-tabs` |
| PATCH | `/api/terminal-tabs?project=` | Persist the project's tab order `{order: id[]}` |
| PATCH | `/api/terminal-tabs/:id?project=` | Rename a tab `{label}` |
| DELETE | `/api/terminal-tabs/:id?project=` | Close a tab: end its record (never relaunched) and kill its pty |
| GET | `/api/spawn-queue` | Debug: spawn-queue snapshot (pending/in-flight/reserved, softCap) |
| POST | `/api/internal/restart-drain/prepare` | Dev-runner restart handshake (internal: `x-lattice-terminal-token` required, any browser `Origin` refused). `{reason, ttlMs, budgetMs}` → enter the TTL-bounded drain (no new spawns / run-lock acquisitions; workflow / merge / task / push / QA starts 503 `backend-restarting`), wait for in-flight transitions, flush state → `{ready, pending, waitedMs, pid}`. See `backend/src/restartDrain/CLAUDE.md` |
| POST | `/api/internal/restart-drain/cancel` | End a drain the dev runner won't follow with a restart (internal, token-guarded) |
| GET | `/api/internal/restart-drain/lock-holders` | Per project hash: is the run.lock holder parked on a live conflict resolver / post-merge hook? Feeds the dev runner's 15-min force-restart exemption (internal, token-guarded) |
| GET | `/api/terminal-server/status` | `{state: current\|stale\|absent\|unavailable, sessions}` — whether the detached terminal-server runs this backend's build. `stale` = an update is deferred until the executor has zero ptys; backs the navbar's "terminal server update pending" chip (`backend/src/terminalServerStatus.ts`) |
| WS | `/ws/terminal?id=&cwd=&cols=&rows=&initialCommand=` | xterm proxy via node-pty (with replay) |
| WS | `/ws/terminal-activity?project=` | Which pty sessions are running a harness that's *still working* (sustained printable output seen recently). Pushed on connect + on every change; backs the sidebar's per-tab spinner. Payload is machine-wide (`{busy: serverId[]}`), not project-filtered |
| WS | `/ws/terminal-tabs?project=` | The durable terminal-tab registry, live: `hello` snapshot, then `upsert` / `ended` / `removed` / `restored` / `restore-failed` / `restore-summary` |
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

Every project-scoped route refuses a relative or drive-relative `project`
(or `path` / `cwd`) with a **400** naming the likely cause (shell-stripped
backslashes: `C:developmentproj`) — and on Windows a root-relative one too
(`\foo`, MSYS `/c/development/proj`, which `path.isAbsolute` accepts but
`path.resolve` pins to `C:\c\development\proj`); the check is
`isRealAbsoluteProjectPath` in `backend/src/projectPath.ts`. The stores resolve paths via
`canonicalProjectPath` = `path.resolve`, so such a value would land under the
backend's own cwd — `backend/src/routes/projectParam.ts` (non-task routes) and
`routes/tasks/requestUtils.ts` (task routes) are the guards.

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
  index free among active tasks, with an in-memory *reservation* held from
  the moment a start picks its slot until its status flip lands, since the
  spawn queue admits up to `softCap` starts concurrently and overlapping
  "Run All" siblings otherwise computed the same lowest free slot) mapped
  through a golden-angle palette — a re-run keeps its stored slot only while
  no other active task holds it — so
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
- **Agent overlay (graph) — Claude, Codex and Pi alike.** Each in-progress
  task shows a free-floating filled agent node; while its agent reads/modifies
  files a TTL-fading focus beam links the node to each file node, and a label
  beside the node names the file it last touched. **Subagents** appear as
  smaller **satellite** nodes that follow the parent, each with its own focus
  beams and **its own current-file label**. Every agent/satellite label is
  spread in screen space each frame so a busy cluster's text never overlaps
  (`agentOverlayLabelLayout.ts` — a snap, never an idle-controller hold); a
  label pushed off its row gets a faint leader line back to its orb. Graph
  settings → Sizes → "Subagent labels" (`graphSettings.showSubagentLabels`, off
  by default) prefixes each satellite's label with its `agent_type`. Activity
  sources, all decoded by the same routes (`backend/src/activityHook.ts` +
  `hookFiles.ts`) into `task-activity` / `agent-activity` WS events:
  **Claude** — PreToolUse/PostToolUse/SubagentStart/SubagentStop hooks in
  `.claude/settings.local.json` (a subagent's tool use carries `agent_id`);
  **Codex** — the same four events in `.codex/hooks.json` (`codexStopHook.ts`),
  where edits are `apply_patch` (each patch file header is a beam while that
  file exists — so a Move/Delete source drops at PostToolUse, an Add target at
  PreToolUse) and reads are shell commands (candidate paths kept only if they
  exist, resolved under the tool's `workdir` and a leading `cd <dir> &&`; any
  other directory change drops them — a miss beats a wrong beam); **Pi** — the
  `.pi/extensions/lattice-activity.ts` extension (`backend/src/piActivity.ts`)
  posting Claude-shaped bodies from `tool_execution_start/end`, with a
  pi-subagents subagent (an in-memory session) reported as a satellite.
  Holding **`W`** outlines every file changed by a not-yet-merged task in that
  task's color. See `frontend/src/components/forceGraph/CLAUDE.md`.
- **Non-worktree agent sessions** (push runs, workflow steps, post-merge
  hooks) get the *same* node + beams + subagent satellites, but a fixed
  orange (`CLAUDE_ORANGE`) since they have no task color. Presence is registry-
  driven (`backend/src/agentSessions.ts` → `/ws/agent-sessions`): a node
  appears at spawn and disappears at the session's completion callback;
  beams come from the `/api/agent-activity/:token` hook
  (`backend/src/agentActivity.ts`) — installed for every harness (Claude
  hooks, Codex `hooks.json`, the Pi activity extension).
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
  own `0600` `~/.lattice/mcpSecrets.json`. **Every third-party server is off by
  default**, with three independent per-harness switches per server (enabling
  for one harness never loads it into another). **The one exception is
  Lattice's own first-party `lattice` server** (`backend/src/latticeMcp/`,
  catalog `defaultEnabled: true`): a stdio server spawned with the backend's
  own `node`, a thin typed client over the task-board HTTP API
  (`board_summary`, `list_tasks`, `get_task`, `search_tasks`, `create_task(s)`,
  `update_task`, `transition_tasks`, `append_summary`, `delete_task`,
  `run_task`). A **task worktree's session** gets a reduced set instead: the
  run/resume spawn (and a worktree merge-conflict resolver) injects
  `LATTICE_TASK_ID`, which adds `my_task`, makes
  `append_summary` default to the agent's own task, and drops the
  board-management tools (`update_task`, `transition_tasks`, `delete_task`,
  `run_task`) — a worktree agent's brief is untrusted input, and it reads,
  files follow-ups and reports rather than re-laning or deleting. **Task
  worktree sessions get ONLY the Lattice MCP by default**: with the per-project
  `taskAgentsLatticeMcpOnly` setting on (default; Settings → MCP tab checkbox),
  a task run/resume or a worktree merge-conflict resolver (spawn option
  `mcpScope: 'task-worktree'`, cwd under `~/.lattice/worktrees/` — never a
  project root) gets just the `lattice` server — Claude via
  `--strict-mcp-config --mcp-config=<home-scratch file>`, Codex by disabling the
  user's config.toml servers by name, Pi via a lattice-only `.pi/mcp.json` (Pi's
  adapter still merges its own global files). Saves the idle Playwright/Blender
  processes every agent otherwise carried; every other session keeps the full
  enabled set. See `backend/src/mcp/CLAUDE.md`. Every by-id
  call is project-pinned server-side: the routes 404 a task from another board
  when `?project=` is sent (`requireTaskInRequestedProject`). It is ON for all three harnesses unless
  the per-harness toggle is set to `false`, and the resolver injects
  `LATTICE_API_URL` + `LATTICE_PROJECT` per spawn so tools never take a `project` argument and
  the server does the `canonicalProject` check agents used to do by hand.
  Its tool descriptions carry the progressive-disclosure guidance (start with
  `board_summary`; `list_tasks` is compact/active/newest-100; `get_task` for
  full text; `search_tasks` instead of listing) so an agent can't fall into
  the 1 MB unfiltered dump the raw curl allowed. Injection is resolved in the backend at the spawn
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
- **Opengrep (SAST) is a pre-run tool, not a dependency.** Opengrep — the
  LGPL-2.1 community fork of Semgrep CE, a local offline static-analysis
  engine — is installed at the user's click in **Settings → Tools**: the
  pinned release asset for this platform (picked automatically from
  `process.platform`/`arch`, Windows ARM64 falls back to the x64 build) is
  downloaded into `~/.lattice/opengrep/bin/<version>/`, verified against the
  SHA-256 pinned in `backend/src/opengrep/versions.ts` (which
  `scripts/opengrep-pin.mjs` only writes after `cosign verify-blob` confirms
  the Sigstore signature of the Opengrep release workflow), and run once. A
  copy already on PATH always wins. Rule packs are fetched the same way at a
  pinned commit (`git fetch --depth 1`) into `~/.lattice/opengrep/rules/`:
  `qodana-mit` (MIT, its LGPL/Commons-Clause folders pruned) and the archived
  `opengrep-rules` snapshot (LGPL-2.1 + Commons Clause — the only pack with
  real TypeScript/Node/Express coverage). Both are used by scans once
  installed; each INSTALL is an explicit click with the licence named on the
  row, and the archived pack's install asks you to acknowledge its no-resale
  condition first. `<project>/.opengrep/rules/` is always loaded.
  **Lattice stays MIT because nothing third-party is ever committed or
  bundled** (guard test `opengrepNoVendoredAssets`) and the engine only runs
  as a child process. Agents never see raw JSON: `backend/src/opengrep/digest.ts`
  renders a **digest** — the project's severity floor (default WARNING) and
  ignore lists (rule id or fingerprint, `userSettings.opengrep`) applied
  first, deduplicated by Opengrep's stable per-finding **fingerprint**,
  grouped rule → file, under a byte budget (60 KB) with a drill-down pointer.
  Surfaces: the **Opengrep workflow step** (the "Opengrep" quick-add chip or
  the "Security review (Opengrep)" template seed a step with
  `WorkflowStep.tools: ['opengrep']`, shown as a read-only shield badge — there
  is deliberately no per-step toggle) scans before the harness spawns and drops
  `OPENGREP_FINDINGS.md` beside `WORKFLOW_STEP.md` (the brief's
  `{{tool_reports}}` section; a missing engine explains itself in the brief
  rather than failing the step; the run strip says "running the Opengrep scan
  before the agent starts…" meanwhile); the `opengrep_scan` /
  `opengrep_findings` / `opengrep_ignore` MCP tools in every session;
  `/api/opengrep/*`. Task markers:
  `opengrep:<fp>` on its own line, so a re-run finds the existing task via
  `search_tasks`. One scan per project at a time, `--jobs = cores-2`, 10-min
  cap, never on file watch; results under
  `~/.lattice/per-project/<hash>/opengrep/` (last 10). See
  `backend/src/opengrep/CLAUDE.md`.
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
  step, prompt customization, post-merge hook). The model half may contain
  further slashes — an OpenAI-compatible server usually reports the HuggingFace
  repo id it was launched with, giving `my-vllm/meta-llama/Llama-3.1-8B-Instruct`
  — and the frontend mirror (`frontend/src/harnesses.ts` `PI_MODEL_RE`) must stay
  in lockstep: a pattern either side rejects has its `--model` flag *silently
  dropped*, so the session runs Pi's default model instead of the chosen one.
  Model SELECTION is per-spawn via the flag, never `~/.pi/agent/settings.json`.
  **Endpoint management (Settings → Pi):** OpenAI-compatible providers (vLLM,
  …) are declared in `globalSettings.piProviders` and *reconciled into*
  `~/.pi/agent/models.json` by `reconcilePiModelsJson()` (boot + after a
  global-settings PATCH that carries `piProviders`). Lattice owns exactly the
  provider ids it manages — tracked in the `~/.lattice/piManagedProviders.json`
  sidecar so a UI removal is a precise delete — and *preserves every
  hand-written provider* (and any `compat`/`headers` on a re-managed id).
  **Auto-discovery** (`piModels/autoDiscover.ts`, `PiProvider.autoDiscover`,
  default ON) re-probes each managed endpoint on boot, on a settings save, and
  whenever a harness dropdown opens (`GET /api/pi-models`, TTL-throttled +
  single-flighted), folds the live `/v1/models` listing into the stored provider
  and reconciles — so pasting a base URL is the whole setup, and restarting a
  local server on different weights just changes the row. Failure is
  non-destructive: an unreachable endpoint, or one that lists nothing, keeps its
  last known-good models, because an empty provider is what makes Pi report *no
  models at all* (a custom endpoint is often the only provider configured).
  Reconcile runs on every sweep, not only when the probe moved something —
  models.json drifts from `globalSettings` independently, and that drift is
  exactly the broken state — and it skips the write when the file already
  matches. Only the CURRENTLY-SERVED models are discoverable: `/v1/models` is
  the whole OpenAI-compatible contract, with no way to enumerate unloaded
  weights or ask a server to load different ones (Pi's llama.cpp `/llama`
  integration is the one exception, and it is llama.cpp-specific). An
  auto-discovering endpoint's models bypass `piModelMenu` curation — otherwise a
  model you just loaded would stay hidden until you re-ticked a checkbox — so
  Settings renders those rows fixed with an "auto" tag rather than offering a
  checkbox that does nothing. That bypass stops at
  `PI_MODELS_CONFIG.aggregatorModelCount` (5): past it an endpoint is an
  **aggregator** (OpenRouter lists ~450) whose models are curated through the Pi
  model menu instead of surfacing wholesale. Capability probing has its OWN,
  looser limit (`thinkingProbeModelLimit`, 25) — one probe per model once ever,
  so a box serving eight models still gets its thinking levels detected even
  though its dropdown rows are curated. **Thinking levels** are detected per
  model and written as Pi's `thinkingLevelMap`; without it Pi silently clamps
  `xhigh`/`max` to `high`. Pick a level with `/thinking` in a session (Ctrl+S
  saves it to Pi's own `settings.json`, which Lattice still never writes),
  `pi --thinking <level>`, or the `provider/model:<level>` pattern the harness
  selectors already validate. One consequence worth knowing: an endpoint whose
  `apiKey` uses Pi's `$VAR` interpolation or `!command` form will fail its probe,
  since probes resolve neither (no ambient secrets to a user-supplied URL, no
  command execution on a timer) — it keeps its last known models and logs why,
  and has to be configured by hand in `globalSettings.json`. The
  "Detect models" button hits `POST /api/pi-endpoints/probe`, which also reads
  each model's advertised context window (`max_model_len` on vLLM/NInfer/SGLang,
  `context_length` on llama.cpp/LM Studio, …) and saves it as the model's
  `contextWindow` — without it Pi sizes its budget from a conservative default,
  which silently wastes most of a 262K-context local server. Per-endpoint
  **Advanced** also exposes the provider `api` protocol (blank =
  `openai-completions`), `compat`, and custom headers. When two endpoints serve
  the same model id, the menu qualifies *only* the colliding labels with their
  provider id (`qwen3.6-35b-a3b (box-b)`). `settings.json` defaults are still
  never touched.
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
- **Per-tab agent spinner.** A sidebar tab swaps its icon for a small spinner
  while the harness in that pty is working. **Codex uses its explicit terminal
  title status**, configured per invocation with `tui.terminal_title=['status']`
  by the main backend before HTTP or serverless WS creation. `Working` spins;
  `Ready`, action-required, custom/disabled/unknown titles do not. Printable
  welcome-screen animation at an empty prompt must never count as Codex work.
  Quiet active turns remain busy, including when Codex animations are disabled.
  No global Codex config is written; later explicit command-line overrides win.
  The same injection sets `tui.terminal_resize_reflow_max_rows=500`: Codex
  clears and re-emits its transcript on every terminal width change (its
  resize reflow, no off switch), capped per detected terminal — 9001 rows
  under the `WT_SESSION` a Lattice-spawned Codex inherits from the dev server —
  which is what made a sidebar drag or a reconnect take minutes. The
  frontend also sends the pty ONE resize per settled drag
  (`terminalSocket.ts` `RESIZE_DEBOUNCE_MS`), refits only the visible pane,
  and clears the xterm buffer (never a full reset, which would drop the TUI's
  bracketed-paste / mouse / alt-screen modes) on every `attached` frame so a
  reconnect's scrollback replay is painted once, not appended under the old
  content.
  **Claude/Pi use sustained printable output that the user isn't driving**;
  focus, scrolling and resizing must not accumulate false busy runs.
  `backend/src/terminalActivity.ts` derives the signal and pushes it over
  `/ws/terminal-activity`. The detached executor reports raw `lastOutputAt`,
  `lastTextOutputAt`, the latest bounded `terminalTitle`, and `initialCommand`.
  `terminalActivityRelay.ts` can obtain the same title from existing browser
  streams for retained old executors. It creates no extra connections or PTYs.
  Native telemetry wins, including an explicit unknown title. The shared poller
  expires unavailable display state after five seconds; the frontend clears
  activity on disconnect/project switch and suppresses exited/dead tabs.
  It must come from the backend because the sidebar lazy-mounts a `TerminalPane`
  only after a tab's first activation — an un-clicked tab has no WS of its own,
  and those are exactly the tabs the spinner is for. Harness sessions only: a
  plain shell or a `npm run dev` startup terminal streams output for its whole
  life and would pin the spinner on. Old Codex launches without the status-title
  default, or unopened tabs on an old executor without native titles, remain
  unknown until a new launch or telemetry becomes available. Live PTYs are
  preserved across backend restarts; never kill them to upgrade this indicator.
- **Terminal tabs survive restarts and reboots.** Every pty the backend creates
  (all ten spawn sites, incl. sidebar `+` launches and startup terminals) is
  recorded in the per-project registry (`backend/src/terminalRegistry/`) under a
  backend-minted tab id that the frontend adopts as `TerminalSpec.id`. At the
  spawn chokepoint Lattice pins the harness conversation — Claude
  `--session-id <uuid>`, Pi `--session-id lattice-<uuid>` — and learns a Codex
  thread id from its rollout file afterwards. On project open the frontend calls
  `POST /api/terminal-tabs/restore` (per `restoreTerminalsOnOpen`: `always` /
  `ask` / `never`, plus a manual button): live ptys are re-attached, a pty that
  exited while the executor lived is dropped, and a dead one (executor replaced)
  is relaunched INTO ITS PREVIOUS CONVERSATION (`claude --resume <id>`,
  `pi --session-id <id>`, `codex resume <id>`) with the original flags. Task /
  merge-resolver relaunches get a continue-nudge prompt (the Stop hook still
  drives `/complete`); a user tab only when `restoreNudgeUserTabs` is on AND
  the interruption detector finds the agent was mid-turn. One-shot runs (push /
  QA / post-merge / workflow steps) are owned by their own recovery and never
  resurrected here. Scrollback is not restored across a reboot (harness TUIs
  re-render on resume). Startup terminals are reseeded by the sidebar
  (`useStartupTerminals` → `planStartupSeeding`), which consults the registry
  snapshot as well as the live pty list, so a startup whose pty is alive is
  never spawned a second time on a fresh browser context.
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
- **Lattice self-discovery is a system-prompt preamble**, injected on that same
  append channel at every spawn in every project with a `.lattice/` dir
  (`harnessSystemPrompts/latticePreamble.ts`). One paragraph: what Lattice is,
  its trigger words (task board, lanes, worktrees, merging, workflows, startup
  terminals), the absolute path of that project's auto-generated
  `.lattice/LATTICE_API.md`, and a nudge to prefer the `lattice` MCP tools
  when the session has them. The doc is deliberately a SHORT index (≤ ~3.5 KB:
  literal values, concepts, the cheapest-first tier table, five core recipes)
  that points at a sibling `.lattice/LATTICE_API_RECIPES.md` for the full
  endpoint table and the batch / markdown round-trip / bulk recipes — agents
  read the pointer target whole, so the index is what every Lattice question
  costs and the recipes are read only when needed. Both are regenerated from
  `backend/src/latticeApiDocs/*.template.md` (content-hash stamped) and
  drift-tested against the live route table. It is invisible to the user and takes no
  part in Claude Code's session naming, which is why it is a system prompt and
  not a typed first turn. **Two earlier channels could never work and must not
  be reintroduced**: `LATTICE_*` pty env vars (removed — no harness reads the
  environment into its context) and the dim terminal banner (kept, but it lands
  in the scrollback the browser replays, so the pty child never receives it —
  it informs the *user*, not the agent).
- **Task agents don't run tests.** Task run/resume sessions and their worktree
  merge resolvers are told — in the brief's `{{verification}}` block AND their
  system prompt — to run no test suite, build or type-check, overriding repo
  CLAUDE.md/AGENTS.md and the task description (`backend/src/taskVerification.ts`).
  Eight agents each running a monorepo's full suite + a cold `tsc -b` was most of
  the machine's CPU; a workflow's Run tests step verifies merged work once
  instead. Per-project opt-in `taskAgentTypecheck` (Settings → Agent prompts)
  allows a type-check of the edited package(s).
- **Workflow "Run tests" step** (kind `test`, quick-add chip "Run tests",
  usually `… → Merge → Run tests → Push`). An agent step with a fixed brief
  (`RUN_TESTS.md`, template `run-tests`): from its step dir it `cd`s into the
  project, runs the project's tests on the main checkout, fixes what it can and
  commits with `git commit -- <paths>` (never `add -A`/stash/reset/push), leaves
  the user's uncommitted files (listed in `USER_WIP.txt`) alone, and writes
  `TEST_SUMMARY.md`, which lands on the run as `stepSummaries[i]` and in the
  run strip. It **never stops the workflow**: skipped when HEAD hasn't moved
  since the last Run tests (`~/.lattice/per-project/<hash>/run-tests.json`) or
  the checkout is detached; a spawn failure, lost terminal, failing completion
  checkpoint or its `timeoutMinutes` (default 60, counted from the pty spawn;
  the session is killed, uncommitted leftovers listed, nothing reverted) all
  become a note + advance. It holds the project `run.lock` as
  `workflow-test:<runId>` **non-lendably**: manual Merge / Merge All get a 409
  naming the step, and a resolver finalize, snapshot or out-of-run post-merge
  hook waits for the release. The workflow **Push** step now has its own
  push-only brief (`workflow-push`: no add/commit, uncommitted files reported);
  the QA-lane Push button keeps its commit-then-push brief. See
  `backend/src/workflowRuns/CLAUDE.md` (`testStep/`).

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
