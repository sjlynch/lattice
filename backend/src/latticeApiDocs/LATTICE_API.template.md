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

```pwsh
irm -Method Patch -Uri "$env:LATTICE_API_URL/api/tasks/$id" `
    -ContentType 'application/json' -Body (@{ status = 'qa' } | ConvertTo-Json)
```

```bash
curl -s -X PATCH "$LATTICE_API_URL/api/tasks/$id" \
  -H "Content-Type: application/json" -d '{"status":"qa"}'
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
| GET    | /api/tasks?project=&status=        | List tasks (envelope: `{project, canonicalProject, hash, count, mismatched, tasks}`); `status` optional, comma-separated |
| GET    | /api/tasks/summary?project=        | Counts envelope: `{project, canonicalProject, hash, total, mismatched, byStatus}` |
| GET    | /api/tasks/:id                     | Fetch one task |
| POST   | /api/tasks                         | Create one (JSON, form-encoded, or query-string `project`) |
| POST   | /api/tasks/batch                   | Create many — JSON `{tasks:[...]}` OR `text/markdown` body |
| POST   | /api/tasks/transition              | Bulk status move `{ids?, fromStatus?, status}` |
| PATCH  | /api/tasks/:id                     | Update title / description / status |
| POST   | /api/tasks/:id/append-summary      | Append a summary section to the existing description |
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

Statuses: `backlog | open | in_progress | ready_to_merge | qa | done | deleted`.
Pipeline: `open → in_progress → ready_to_merge → qa → done` (drag-and-drop
in the UI moves `qa → done`; everything else is automated).

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
