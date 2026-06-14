# Lattice API

Lattice is a local task / worktree orchestrator running on this machine.
This terminal has these env vars set (this session only — not your global env):

- `$LATTICE_API_URL` — API base URL (default `http://127.0.0.1:{{API_PORT}}`)
- `$LATTICE_PROJECT` — active project's absolute path
- `$LATTICE_PROJECT_HASH` — 12-char project hash (compare against the `hash` field in API responses)
- `$LATTICE_DOCS` — absolute path to this file

If the user mentions tasks / taskboard / merging / worktrees, drive the
HTTP API below directly — don't ask how to reach it.

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
3. **The `project` you pass must be `$LATTICE_PROJECT`.** Don't
   hardcode a path, don't infer from the cwd, don't reuse one from an
   earlier session. `/api/tasks` and `/api/tasks/summary` return an
   envelope with a `canonicalProject` field — if it doesn't match
   `$LATTICE_PROJECT` (or the `hash` doesn't match `$LATTICE_PROJECT_HASH`),
   stop and tell the user, don't act on the data.

## Recipes

### Anti-pattern: don't trust `.lattice/**/tasks*.json` files

If you find files like `.lattice/workflow-steps/*/tasks.json`,
`tasks-current.json`, `combined-tasks.json`, `lattice_tasks.json`, etc.,
**those are stale scratch from previous agents — not the source of
truth.** The live task DB is the API. Always query
`$LATTICE_API_URL/api/tasks?project=$LATTICE_PROJECT`. Don't grep the
filesystem to "find" tasks.

### Seeding many tasks at once — markdown body (any shell, zero escaping)

The simplest way to batch-create tasks. A heredoc with single-quoted
`'EOF'` passes the body through *literally* — no JSON, no escaping,
no `jq`, no python. Each `# Heading` is a task title; lines below it
become the description until the next heading.

```bash
curl -s -X POST "$LATTICE_API_URL/api/tasks/batch?project=$LATTICE_PROJECT" \
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
curl -X POST "$LATTICE_API_URL/api/tasks?project=$LATTICE_PROJECT" \
  --data-urlencode "title=<short title>" \
  --data-urlencode "description=<details, multi-line OK>"
```

### List & count (no script needed)

Both endpoints return an envelope, not a bare array. Always read
`.canonicalProject` first and confirm it matches `$LATTICE_PROJECT`
before iterating `.tasks` (or trusting `.byStatus`).

PowerShell — `Invoke-RestMethod` (alias `irm`) handles JSON automatically:
```pwsh
$proj = $env:LATTICE_PROJECT.Replace('\','/')

# all open tasks
$resp = irm "$env:LATTICE_API_URL/api/tasks?project=$([uri]::EscapeDataString($proj))&status=open"
if ($resp.canonicalProject -ne $env:LATTICE_PROJECT) { throw "wrong project: $($resp.canonicalProject)" }
$resp.tasks   # ← the actual task list

# counts by status (one round trip, no client-side tally)
$sum = irm "$env:LATTICE_API_URL/api/tasks/summary?project=$([uri]::EscapeDataString($proj))"
if ($sum.canonicalProject -ne $env:LATTICE_PROJECT) { throw "wrong project: $($sum.canonicalProject)" }
$sum.byStatus  # → @{ open = 8; done = 28; ... }
```

bash — `curl --data-urlencode` does the encoding for you. Pipe the body
through `jq` to assert the project and extract `.tasks`:
```bash
curl -sG "$LATTICE_API_URL/api/tasks" \
  --data-urlencode "project=$LATTICE_PROJECT" \
  --data-urlencode "status=open" \
  | jq --arg p "$LATTICE_PROJECT" '
      if .canonicalProject == $p then .tasks
      else error("wrong project: " + .canonicalProject) end'

curl -sG "$LATTICE_API_URL/api/tasks/summary" \
  --data-urlencode "project=$LATTICE_PROJECT" \
  | jq --arg p "$LATTICE_PROJECT" '
      if .canonicalProject == $p then {total, byStatus}
      else error("wrong project: " + .canonicalProject) end'
```

You can also pass multiple statuses: `?status=open,in_progress`.

Response envelope shape:
```jsonc
{
  "project":          "C:\\dev\\my-app",   // exactly what you passed
  "canonicalProject": "C:\\dev\\my-app",   // ← MUST match $LATTICE_PROJECT
  "hash":             "3f9a2b1c8e7d",       // ← MUST match $LATTICE_PROJECT_HASH
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
  project = $env:LATTICE_PROJECT.Replace('\','/')
  title = '<short title>'
  description = @'
Multi-line is fine. "Quotes" and \backslashes\ pass through untouched.
For paths inside the description, use forward slashes: F:/rust_etl/src/foo.rs
'@
} | ConvertTo-Json -Depth 5
irm -Method Post -Uri "$env:LATTICE_API_URL/api/tasks" -ContentType 'application/json' -Body $body
```

bash — if `jq` is available, pipe its output as the body; otherwise
write JSON to `$TMPDIR/lattice_*.json`, POST it, then delete:
```bash
jq -nc \
  --arg project   "$LATTICE_PROJECT" \
  --arg title     "<short title>" \
  --arg description "<details>" \
  '{project:$project, title:$title, description:$description}' |
curl -s -X POST "$LATTICE_API_URL/api/tasks" \
  -H "Content-Type: application/json" --data-binary @-
```

### Create many tasks at once

PowerShell scales naturally — same hashtable pattern, with a list:
```pwsh
$body = @{
  project = $env:LATTICE_PROJECT.Replace('\','/')
  tasks = @(
    @{ title = 'first';  description = 'details 1' },
    @{ title = 'second'; description = 'details 2' }
  )
} | ConvertTo-Json -Depth 5
irm -Method Post -Uri "$env:LATTICE_API_URL/api/tasks/batch" -ContentType 'application/json' -Body $body
```

### Update a task

For a single field (like flipping status), JSON is fine:
```bash
curl -s -X PATCH "$LATTICE_API_URL/api/tasks/$id" \
  -H "Content-Type: application/json" -d '{"status":"qa"}'
```

```pwsh
irm -Method Patch -Uri "$env:LATTICE_API_URL/api/tasks/$id" `
    -ContentType 'application/json' -Body (@{ status = 'qa' } | ConvertTo-Json)
```

### Replace a task's description with markdown — heredoc, zero escaping

This is the killer ergonomics path for refining long task descriptions.
The body is taken literally; if you include a `# Heading` it becomes the
new title and the lines below it become the new description. No heading?
The whole body just replaces the description.

```bash
curl -s -X PATCH "$LATTICE_API_URL/api/tasks/$id" \
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
irm -Method Patch -Uri "$env:LATTICE_API_URL/api/tasks/$id" `
    -ContentType 'text/markdown' -Body $body
```

### Update many tasks at once

Two paths, pick whichever fits your flow.

**JSON bulk-update** — one round trip, N patches, no shell loop:
```bash
curl -s -X POST "$LATTICE_API_URL/api/tasks/bulk-update" \
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
curl -sG "$LATTICE_API_URL/api/tasks" \
  --data-urlencode "project=$LATTICE_PROJECT" \
  --data-urlencode "status=backlog" \
  --data-urlencode "format=markdown" > /tmp/backlog.md

# 2. Edit /tmp/backlog.md however you like:
#    - Keep `# {id=t_abc, status=backlog} ...` headings on tasks you want
#      to UPDATE (edit the title or body freely).
#    - Add new `# Title` headings (no {id=...}) for tasks to CREATE.
#    - Leave tasks you don't want to touch out of the doc entirely.

# 3. POST it back
curl -s -X POST "$LATTICE_API_URL/api/tasks/upsert?project=$LATTICE_PROJECT" \
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
curl -s -X POST "$LATTICE_API_URL/api/tasks/transition?project=$LATTICE_PROJECT" \
  -H "Content-Type: application/json" \
  -d '{"fromStatus":"qa","status":"done"}'

# Or by explicit ids
curl -s -X POST "$LATTICE_API_URL/api/tasks/transition" \
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
| PATCH  | /api/tasks/:id                     | Update title / description / status. Accepts JSON OR `text/markdown` body (replaces description; `# Heading` replaces title too) |
| POST   | /api/tasks/:id/append-summary      | Append a summary section. JSON `{summary}` OR `text/markdown` body |
| DELETE | /api/tasks/:id                     | Remove a task |
| POST   | /api/tasks/:id/run                 | Spawn worktree + Claude on an open task |
| POST   | /api/tasks/:id/resume              | Re-spawn Claude in an existing worktree |
| POST   | /api/tasks/:id/merge               | Attempt git merge of a Ready-to-Merge task |
| POST   | /api/merge-runs                    | Body `{project}` — merge every Ready-to-Merge task |
| GET    | /api/merge-runs/active?project=    | Active merge run, or `null` |
| POST   | /api/merge-runs/:id/cancel         | Cancel a merge run |
| GET    | /api/workflow-runs/active?project= | Active workflow runs |
| POST   | /api/workflows/:id/run             | Start a workflow run; optional `{harnessOverride}` |
| GET    | /api/settings?project=             | Per-project user settings (read) |
| PATCH  | /api/settings?project=             | Per-project user settings (update) |
| GET    | /api/project-env?project=          | Auto-detected package-manager envs + injected worktree notes |
| GET    | /api/health/dead-code?project=     | Files the analyzer flags as unreachable: `{files:[{path,ext}], total, scannedAt}` (empty if the confidence guard tripped) |

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
curl -sG "$LATTICE_API_URL/api/health/dead-code" \
  --data-urlencode "project=$LATTICE_PROJECT"
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
- Pass `$LATTICE_PROJECT` (or its forward-slash form) verbatim as the
  `project` field. Lattice canonicalizes drive-letter casing.

This file is auto-managed by Lattice. It's regenerated whenever its
content changes upstream — don't edit; fork it elsewhere if you need a
customized copy.
