# Lattice API

Lattice is a local task / worktree orchestrator running on this machine.
If the user mentions tasks / taskboard / merging / worktrees, drive the
HTTP API below directly — don't ask how to reach it.

## Values for THIS session (use these literally)

- **API base URL:** `{{API_URL}}`
- **Project (`project=` field):** `{{PROJECT}}`
- **Same path, forward-slash form** (prefer this in JSON bodies + shell):
  `{{PROJECT_FWD}}`
- **Project hash:** `{{PROJECT_HASH}}`

Every recipe below already has these baked in — copy one and run it. Nothing
here depends on a shell variable expanding, deliberately: the default pty shell
on Windows is `cmd.exe`, where a `$VAR` reference is just a literal string.

## What Lattice is (concepts the user may ask about)

- **Task board** — a kanban whose lanes are
  `Backlog → Open → In Progress → Ready to Merge → QA → Done` (plus a deleted
  bin). *Backlog* holds captured-but-not-yet-actionable work; *Open* is the
  ready-to-run lane. Running an Open task creates a git worktree on branch
  `lattice/<slug>-<id>`, writes the brief to `LATTICE_TASK.md` inside it, and
  spawns a coding agent there. The agent commits and the task lands in
  *Ready to Merge*; a QA pass moves it to *Done*.
- **Merging** — Lattice merges the project's main branch INTO the task branch
  *inside the worktree* first, so main's working tree never carries conflict
  markers. Clean merge → main fast-forwards and the worktree is removed.
  Conflict → a resolver agent is spawned in that worktree, and finalizing
  happens when it finishes. "Merge all" walks every Ready-to-Merge task in
  creation order and continues past conflicts.
- **Worktrees** — one checkout per running task, kept OUTSIDE the project tree
  at `~/.lattice/worktrees/<projectHash>/<slug>-<id>`. The `.lattice/` folder
  inside the project holds only managed state (this file, workflow scratch,
  settings) — never source, and never a place to write helper scripts.
- **Workflows** — saved chains of steps run in order. *Agent* steps spawn a
  harness with a prompt; *control* steps (`start` / `merge` / `push`) drive the
  board itself server-side. Agent steps file tasks, they don't implement.
- **Harnesses** — the coding CLIs Lattice can spawn for a task, workflow step,
  or terminal: `claude`, `codex`, and `pi` (with a per-spawn Pi model).
- **Terminals** — the left sidebar hosts every agent session as a tab, grouped
  into Terminals / Merging / Startup panels. **Startup terminals** are
  per-project commands configured in Settings → Terminals that Lattice launches
  automatically into their own tabs when the project is opened (a dev server, a
  log tail); they can be restarted as a group, and are respawned if their pty
  died while the page was closed.
- **The 3D graph** — the project's source tree as a force-directed DAG, with
  hold-key overlays for code health (`H`), lines of code (`Z`), dead code
  (`D`), files modified by an unmerged task (`W`), and name labels (`Alt`).
  Running agents appear as colored nodes with beams to the files they touch.

Anything in that list the user wants *changed* is a Lattice UI or settings
action on their side — not something to implement in the current repo.

## Hard rules

1. **Don't write helper scripts into `.lattice/`.** That folder is
   Lattice's managed state — leftover `.py` / `.sh` / `.js` files
   there are a mess for the user. If you need a temp script, put it in
   `$env:TEMP` (Windows) or `/tmp` (POSIX) and delete it when done.
   Most operations below are one-liners and need no script at all.
2. **Use forward slashes in JSON paths.** Lattice canonicalizes
   `F:/rust_etl` and `F:\\rust_etl` to the same project, so the
   forward-slash form sidesteps every JSON / shell escape headache.
   For URL query strings, let the HTTP client URL-encode the raw value.
3. **The `project` you pass must be the project path above.** Don't
   hardcode a different path, don't infer it from the cwd, don't reuse one
   from an earlier session. `/api/tasks` and `/api/tasks/summary` return an
   envelope with a `canonicalProject` field — if it doesn't match
   `{{PROJECT}}` (or the `hash` doesn't match `{{PROJECT_HASH}}`),
   stop and tell the user, don't act on the data.

## Recipes

### Anti-pattern: don't trust `.lattice/**/tasks*.json` files

If you find files like `.lattice/workflow-steps/*/tasks.json`,
`tasks-current.json`, `combined-tasks.json`, `lattice_tasks.json`, etc.,
**those are stale scratch from previous agents — not the source of
truth.** The live task DB is the API. Always query
`{{API_URL}}/api/tasks?project=` with the project above. Don't grep the
filesystem to "find" tasks.

### Seeding many tasks at once — markdown body (any shell, zero escaping)

The simplest way to batch-create tasks. A heredoc with single-quoted
`'EOF'` passes the body through *literally* — no JSON, no escaping,
no `jq`, no python. Each `# Heading` is a task title; lines below it
become the description until the next heading.

```bash
curl -s -X POST "{{API_URL}}/api/tasks/batch?project={{PROJECT_FWD}}" \
  -H "Content-Type: text/markdown" --data-binary @- <<'EOF'
# Resolve readme.md merge-conflict markers
Lines 418 and 471-598 still have <<<<<<</>>>>>>> markers from a prior merge.
Reconcile both sections and ensure the docs reflect the current code.

# Refactor PartitionWriters concurrency contract
The doc claims "concurrency-friendly" but write_with takes &mut self,
preventing real cross-thread use. Either:
- Change to &self (sound, since each partition is already Mutex<...>)
- Or strip the docs and per-partition mutexes (former preferred).
EOF
```

### Creating a single task — form-encoded (no JSON at all)

```bash
curl -X POST "{{API_URL}}/api/tasks?project={{PROJECT_FWD}}" \
  --data-urlencode "title=<short title>" \
  --data-urlencode "description=<details, multi-line OK>"
```

### List & count (no script needed)

Both endpoints return an envelope, not a bare array. Always read
`.canonicalProject` first and confirm it matches `{{PROJECT}}`
before iterating `.tasks` (or trusting `.byStatus`).

PowerShell — `Invoke-RestMethod` (alias `irm`) handles JSON automatically:
```pwsh
$proj = '{{PROJECT_FWD}}'
$want = '{{PROJECT}}'

# all open tasks
$resp = irm "{{API_URL}}/api/tasks?project=$([uri]::EscapeDataString($proj))&status=open"
if ($resp.canonicalProject -ne $want) { throw "wrong project: $($resp.canonicalProject)" }
$resp.tasks   # ← the actual task list

# counts by status (one round trip, no client-side tally)
$sum = irm "{{API_URL}}/api/tasks/summary?project=$([uri]::EscapeDataString($proj))"
if ($sum.canonicalProject -ne $want) { throw "wrong project: $($sum.canonicalProject)" }
$sum.byStatus  # → @{ open = 8; done = 28; ... }
```

bash — `curl --data-urlencode` does the encoding for you. Pipe the body
through `jq` to assert the project and extract `.tasks`:
```bash
curl -sG "{{API_URL}}/api/tasks" \
  --data-urlencode "project={{PROJECT_FWD}}" \
  --data-urlencode "status=open" \
  | jq --arg p '{{PROJECT}}' '
      if .canonicalProject == $p then .tasks
      else error("wrong project: " + .canonicalProject) end'

curl -sG "{{API_URL}}/api/tasks/summary" \
  --data-urlencode "project={{PROJECT_FWD}}" \
  | jq --arg p '{{PROJECT}}' '
      if .canonicalProject == $p then {total, byStatus}
      else error("wrong project: " + .canonicalProject) end'
```

You can also pass multiple statuses: `?status=open,in_progress`.

Response envelope shape:
```jsonc
{
  "project":          "C:\\dev\\my-app",   // exactly what you passed
  "canonicalProject": "C:\\dev\\my-app",   // ← MUST match the project above
  "hash":             "3f9a2b1c8e7d",       // ← MUST match the hash above
  "count":            36,
  "mismatched":       0,                    // foreign tasks server-filtered; > 0 = corruption signal
  "tasks":            [ /* ... */ ]
}
```

### Create one task

PowerShell — hashtable + `ConvertTo-Json`. No quote escaping, no
backslash gymnastics, multi-line descriptions just work:
```pwsh
$body = @{
  project = '{{PROJECT_FWD}}'
  title = '<short title>'
  description = @'
Multi-line is fine. "Quotes" and \backslashes\ pass through untouched.
For paths inside the description, use forward slashes: F:/rust_etl/src/foo.rs
'@
} | ConvertTo-Json -Depth 5
irm -Method Post -Uri "{{API_URL}}/api/tasks" -ContentType 'application/json' -Body $body
```

bash — if `jq` is available, pipe its output as the body; otherwise
write JSON to `$TMPDIR/lattice_*.json`, POST it, then delete:
```bash
jq -nc \
  --arg project   '{{PROJECT_FWD}}' \
  --arg title     "<short title>" \
  --arg description "<details>" \
  '{project:$project, title:$title, description:$description}' |
curl -s -X POST "{{API_URL}}/api/tasks" \
  -H "Content-Type: application/json" --data-binary @-
```

### Create many tasks at once

PowerShell scales naturally — same hashtable pattern, with a list:
```pwsh
$body = @{
  project = '{{PROJECT_FWD}}'
  tasks = @(
    @{ title = 'first';  description = 'details 1' },
    @{ title = 'second'; description = 'details 2' }
  )
} | ConvertTo-Json -Depth 5
irm -Method Post -Uri "{{API_URL}}/api/tasks/batch" -ContentType 'application/json' -Body $body
```

### Update a task

For a single field (like flipping status), JSON is fine:
```bash
curl -s -X PATCH "{{API_URL}}/api/tasks/$id" \
  -H "Content-Type: application/json" -d '{"status":"qa"}'
```

```pwsh
irm -Method Patch -Uri "{{API_URL}}/api/tasks/$id" `
    -ContentType 'application/json' -Body (@{ status = 'qa' } | ConvertTo-Json)
```

### Replace a task's description with markdown — heredoc, zero escaping

This is the killer ergonomics path for refining long task descriptions.
The body is taken literally; if you include a `# Heading` it becomes the
new title and the lines below it become the new description. No heading?
The whole body just replaces the description.

```bash
curl -s -X PATCH "{{API_URL}}/api/tasks/$id" \
  -H "Content-Type: text/markdown" --data-binary @- <<'EOF'
# Refined task title

Use react-flow (MIT-licensed) for the node/canvas mode. Specifically:
- Custom node renderer wired to the existing sprite extension styles.
- Edge type "smoothstep"; preserve the OrbitControls polar clamp.
- Drag-to-pan, scroll-to-zoom, pinch on touch devices.

Avoid d3-zoom directly — react-flow already wraps it.
EOF
```

PowerShell — single-quoted here-string passes the body through literally:
```pwsh
$body = @'
# Refined task title

Use react-flow (MIT-licensed) for the node/canvas mode.
Multi-line is fine. "Quotes" and \backslashes\ pass through untouched.
'@
irm -Method Patch -Uri "{{API_URL}}/api/tasks/$id" `
    -ContentType 'text/markdown' -Body $body
```

### Update many tasks at once

Two paths, pick whichever fits your flow.

**JSON bulk-update** — one round trip, N patches, no shell loop:
```bash
curl -s -X POST "{{API_URL}}/api/tasks/bulk-update" \
  -H "Content-Type: application/json" -d '{
    "updates": [
      { "id": "t_abc", "description": "new description here" },
      { "id": "t_def", "title": "new title", "status": "qa" }
    ]
  }'
```

**Markdown round-trip** — when you want to refine many long descriptions
and/or mix in brand-new tasks. The natural flow is:

```bash
# 1. Fetch the lane as a markdown document
curl -sG "{{API_URL}}/api/tasks" \
  --data-urlencode "project={{PROJECT_FWD}}" \
  --data-urlencode "status=backlog" \
  --data-urlencode "format=markdown" > /tmp/backlog.md

# 2. Edit /tmp/backlog.md however you like:
#    - Keep `# {id=t_abc, status=backlog} ...` headings on tasks you want
#      to UPDATE (edit the title or body freely).
#    - Add new `# Title` headings (no {id=...}) for tasks to CREATE.
#    - Leave tasks you don't want to touch out of the doc entirely.

# 3. POST it back
curl -s -X POST "{{API_URL}}/api/tasks/upsert?project={{PROJECT_FWD}}" \
  -H "Content-Type: text/markdown" --data-binary @/tmp/backlog.md
```

The upsert is **additive only** — tasks NOT in the document are left
untouched. To delete a task, use `DELETE /api/tasks/:id` explicitly.

Document shape (what GET emits and POST accepts):
```markdown
<!-- lattice: project=C:/dev/foo, hash=3f9a2b1c8e7d, status=backlog -->

# {id=t_abc, status=backlog} An existing task
its description, multi-line, code fences, whatever.

# {id=t_def, status=open} Another existing task
description here. Change `status=open` to `status=qa` to move it.

# A brand-new task
description for the new task. No {id=...} → create.
```

### Bulk status transition

Move many tasks to a new status in one call — by explicit IDs or by the
lane they're currently in. Idempotent (tasks already at the target are
no-op):

```bash
# Mark every "qa" task as done in one round trip
curl -s -X POST "{{API_URL}}/api/tasks/transition?project={{PROJECT_FWD}}" \
  -H "Content-Type: application/json" \
  -d '{"fromStatus":"qa","status":"done"}'

# Or by explicit ids
curl -s -X POST "{{API_URL}}/api/tasks/transition" \
  -H "Content-Type: application/json" \
  -d '{"ids":["t_abc","t_def"],"status":"done"}'
```

## Endpoint reference

| Method | Path | Purpose |
|--------|------|---------|
| GET    | /api/projects                      | List indexed project roots: `[{ path, hash }, ...]` |
| GET    | /api/tasks?project=&status=&format= | List tasks (envelope: `{project, canonicalProject, hash, count, mismatched, tasks}`); `status` optional, comma-separated; `format=markdown` returns a round-trippable doc for `/upsert` |
| GET    | /api/tasks/summary?project=        | Counts envelope: `{project, canonicalProject, hash, total, mismatched, byStatus}` |
| GET    | /api/tasks/:id                     | Fetch one task |
| POST   | /api/tasks                         | Create one (JSON, form-encoded, or query-string `project`) |
| POST   | /api/tasks/batch                   | Create many — JSON `{tasks:[...]}` OR `text/markdown` body |
| POST   | /api/tasks/upsert                  | Markdown round-trip: `{id=...}` headings update, no-id headings create. Additive (never deletes) |
| POST   | /api/tasks/bulk-update             | JSON `{updates:[{id, title?, description?, status?}]}` — N patches, one round trip |
| POST   | /api/tasks/transition              | Bulk status move `{ids?, fromStatus?, status}` |
| POST   | /api/tasks/reorder                 | Persist one lane's card order `{project, status, ids}` |
| PATCH  | /api/tasks/:id                     | Update title / description / status. Accepts JSON OR `text/markdown` body (replaces description; `# Heading` replaces title too) |
| POST   | /api/tasks/:id/append-summary      | Append a summary section. JSON `{summary}` OR `text/markdown` body |
| DELETE | /api/tasks/:id                     | Remove a task |
| POST   | /api/tasks/:id/run                 | Run an Open task. Optional `{harness, piModel}`. Returns `{accepted, queued}` — see the async note below |
| POST   | /api/tasks/:id/resume              | Re-spawn the agent in an existing in-progress worktree. Same body and `{accepted, queued}` shape as `/run` |
| POST   | /api/tasks/:id/cancel-queued-run   | Drop a still-queued run, reverting the task to plain Open. Idempotent (no-op if it already started) |
| POST   | /api/tasks/:id/merge               | Attempt git merge of a Ready-to-Merge task |
| POST   | /api/merge-runs                    | Body `{project}` — merge every Ready-to-Merge task |
| GET    | /api/merge-runs/active?project=    | Active merge run, or `null` |
| GET    | /api/merge-runs/:id                | Snapshot one merge run by id (404 once it's been forgotten) |
| POST   | /api/merge-runs/:id/cancel         | Cancel a merge run |
| GET    | /api/workflows?project=            | List workflow definitions — this is how you get the `:id` for the run call below |
| POST   | /api/workflows/:id/run             | Start a workflow run; optional `{harnessOverride}` |
| GET    | /api/workflow-runs/active?project= | Active workflow runs |
| POST   | /api/workflow-runs/:runId/cancel   | Cancel an active workflow run |
| GET    | /api/settings?project=             | Per-project user settings (read) |
| PATCH  | /api/settings?project=             | Per-project user settings (update) |
| GET    | /api/project-env?project=          | Auto-detected package-manager envs + injected worktree notes |
| GET    | /api/health/dead-code?project=     | Files the analyzer flags as unreachable: `{files:[{path,ext}], total, scannedAt}` (empty if the confidence guard tripped) |

> ⚠️ **`/run` and `/resume` are asynchronous.** They put the task on Lattice's
> spawn queue and return `{"accepted":true,"queued":<bool>}` immediately — that
> response means *admitted*, not *started*. When headroom exists the worktree and
> agent terminal come up right away; otherwise the run waits its turn and is never
> dropped. Don't treat `accepted` as "the work is done", and don't re-POST because
> nothing seems to have happened. Poll
> `/api/tasks/:id` (or `/api/tasks/summary`) to watch the status move
> `open → in_progress → ready_to_merge`.

Statuses: `backlog | open | in_progress | ready_to_merge | qa | done | deleted`.
Pipeline: `open → in_progress → ready_to_merge → qa → done` (drag-and-drop
in the UI moves `qa → done`; everything else is automated).

### Finding dead / unreachable code

Lattice's health analyzer computes reachability from detected entry points.
`GET /api/health/dead-code` returns only the files it's *confident* are
unreachable (the list is empty when its confidence guard trips, so a resolver
gap never floods you with false positives). It's a heuristic — it can't see
dynamic `import()`, string-path/`fs` loads, or framework magic — so **verify
before deleting**.

```bash
curl -sG "{{API_URL}}/api/health/dead-code" \
  --data-urlencode "project={{PROJECT_FWD}}"
# → { "files": [ { "path": "src/old/util.ts", "ext": ".ts" }, ... ],
#     "total": 3, "scannedAt": 1718323200000 }
```

## Working with the board

- Group related changes into ONE task. Multiple tasks editing the same
  lines of the same file conflict during the auto-merge, which spawns a
  resolver Claude in each conflicted worktree (slow + brittle).
- Put concrete file paths and acceptance criteria in `description`.
  Each task spawns a fresh Claude with no memory of the user's prior
  conversation.
- Pass the project path above (or its forward-slash form) verbatim as the
  `project` field. Lattice canonicalizes drive-letter casing.

This file is auto-managed by Lattice. It's regenerated whenever its
content changes upstream — don't edit; fork it elsewhere if you need a
customized copy.
