# Lattice API — full reference & recipes

The companion to `LATTICE_API.md` (the short index next to this file). Read a
section when you need it; nothing here is required for ordinary board reads —
the index already covers those.

## Values for THIS session (use these literally)

- **API base URL:** `{{API_URL}}`
- **Project (`project=` field):** `{{PROJECT}}`
- **Same path, forward-slash form** (prefer this in JSON bodies + shell):
  `{{PROJECT_FWD}}`
- **Project hash:** `{{PROJECT_HASH}}`

Every recipe below already has these baked in — copy one and run it. Nothing
here depends on a shell variable expanding, deliberately: the default pty shell
on Windows is `cmd.exe`, where a `$VAR` reference is just a literal string.
Before acting on any response, confirm its `canonicalProject` matches
`{{PROJECT}}` (or that `hash` matches `{{PROJECT_HASH}}`).

## Endpoint reference

| Method | Path | Purpose |
|--------|------|---------|
| GET    | /api/projects                      | List indexed project roots: `[{ path, hash }, ...]` |
| GET    | /api/tasks?project=&status=&ids=&fields=&clip=&since=&limit=&format=&confirm_large= | List tasks. `status` — CSV of lanes or `all`; **defaults to the active lanes** (`backlog,open,in_progress,ready_to_merge,qa`), with the skipped `done`/`deleted` counted in `omitted`. An unknown lane is a **400** naming the valid ones. `ids` — CSV of task ids: the expand tier (bypasses `status` and `since`, implies `fields=full` and `clip=0`, reports `missing`). `fields` — `compact` (default: id/title/status/timestamps + `descriptionBytes`/`summaryBytes`) or `full`. `clip` — max chars of `description`/`summary` under `fields=full`; default 500, `0` = unlimited, sets `descriptionTruncated`/`summaryTruncated`. `since` — ISO-8601, epoch ms (13 digits) or seconds (10), or `30d`/`12h`/`45m`, matched on `lastActivityAt` (`omitted` is counted inside the window). `limit` — default 100, `0` = unlimited, max 1000; ordering is `lastActivityAt` desc. `format=markdown` returns a round-trippable doc for `/upsert` (never clipped). The envelope adds `total`, `matched`, `omitted`, `truncated`, `clipped`, `fields`, `bytes`, `approxTokens`, `hint`. Over 256 KB it returns **413** unless `confirm_large=1` |
| GET    | /api/tasks/summary?project=        | Counts + cost envelope: `{project, canonicalProject, hash, total, mismatched, byStatus, lanes, boardBytes, boardApproxTokens, hint}`. `lanes[status]` = `{count, bytes, approxTokens, newestActivityAt}` for that lane's FULL records, and `boardBytes` prices the whole board (NOT this response, which is under 1 KB) — this is how you price a query before making it |
| GET    | /api/tasks/search?project=&q=&status=&limit= | Find tasks without listing the board. `q` required; whitespace-split terms, all of which must appear (case-insensitive substring) in title/description/summary. `status` CSV or `all` — default `all`, since history is what search is for. `limit` default 20, max 200. Results are `{id, title, status, lastActivityAt, score, snippet}` with title matches weighted ×3 |
| GET    | /api/tasks/:id                     | Fetch one task — the full, never-clipped record |
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
| GET    | /api/merge-runs/recovery?project=  | `{attempts}` — persisted workflow/merge recovery counts and pause reasons; explicit merge start resets its allowance |
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
| POST   | /api/opengrep/scan                 | `{project, targets?, includeMarkdown?}` — run an Opengrep (SAST) scan with the project's rule packs; returns `{scan, digest:{shown,total,bySeverity,rules,bytes}, markdown?}`. **409** `busy` / `not-installed` / `no-rules` |
| GET    | /api/opengrep/scans?project=       | Recent scan records (last 10) |
| GET    | /api/opengrep/scans/:id?project=&format=md&rule=&file=&severity=&budgetKb= | A stored scan (`latest` allowed) as the agent-facing digest: markdown grouped rule → file with a short fingerprint per finding; `rule=`/`file=`/`severity=` narrow it, `budgetKb=` raises the size ceiling. Prefer the `opengrep_scan` / `opengrep_findings` MCP tools when the session has them |
| POST   | /api/opengrep/ignore               | `{project, ruleIds?, fingerprints?}` — add rule ids (full id or dot-suffix) / finding fingerprints (`opengrep:<fp>` spelling accepted) to this project's Opengrep ignore list so future digests skip them. Additive + deduplicated. Use it for rule noise instead of filing a "please ignore X" task (MCP: `opengrep_ignore`) |

Statuses: `backlog | open | in_progress | ready_to_merge | qa | done | deleted`.
Pipeline: `open → in_progress → ready_to_merge → qa → done` (drag-and-drop
in the UI moves `qa → done`; everything else is automated).

> ⚠️ **`/run` and `/resume` are asynchronous.** They put the task on Lattice's
> spawn queue and return `{"accepted":true,"queued":<bool>}` immediately — that
> response means *admitted*, not *started*. When headroom exists the worktree and
> agent terminal come up right away; otherwise the run waits its turn and is never
> dropped. Don't treat `accepted` as "the work is done", and don't re-POST because
> nothing seems to have happened. Poll
> `/api/tasks/:id` (or `/api/tasks/summary`) to watch the status move
> `open → in_progress → ready_to_merge`.

## When a list comes back 413

`GET /api/tasks` refuses a body over 256 KB rather than dumping a megabyte of
done-lane history into your context. The 413 payload carries `bytes`,
`approxTokens`, `ceilingBytes`, the whole `/summary` envelope, and a
`suggestions` array — follow one of them: narrow with `status=`, `since=30d`,
`limit=`, `fields=compact`, or switch to `GET /api/tasks/search`. Pass
`confirm_large=1` only when you genuinely need every byte (you rarely do).

## Sending text and JSON safely

Prefer the `lattice` MCP tools when available; they serialize text safely.
For HTTP summaries and descriptions, write a UTF-8 markdown file with your
file-writing tool, then send it as `text/markdown` with `--data-binary @file`.
Do not put free-form text into hand-written JSON: Windows paths, regex
backslashes, quotes, and newlines can make it invalid or silently change it.
For endpoints requiring JSON, use `JSON.stringify` or `ConvertTo-Json`, write
that output to a UTF-8 file, and send the file with `application/json`.

Use `curl.exe` on Windows to avoid PowerShell's `curl` alias. The single-line
file-upload examples work in cmd.exe, PowerShell, and bash; bash heredocs below
require bash. Check that writes succeed (`--fail-with-body --silent --show-error`
keeps an HTTP error visible and returns a failing exit code).

## Seeding many tasks at once — markdown body (bash heredoc)

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

## Create many tasks at once (JSON)

PowerShell scales naturally — hashtable + `ConvertTo-Json`, with a list:
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

bash — if `jq` is available, pipe its output as the body:
```bash
jq -nc \
  --arg project     '{{PROJECT_FWD}}' \
  --arg title       "<short title>" \
  --arg description "<details>" \
  '{project:$project, tasks:[{title:$title, description:$description}]}' |
curl -s -X POST "{{API_URL}}/api/tasks/batch" \
  -H "Content-Type: application/json" --data-binary @-
```

## Update a task

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

### Append a summary rather than overwrite the description

Write only the summary markdown to a temporary UTF-8 file outside the checkout.
Replace `:id` and the file path below with their actual values:

```text
curl --fail-with-body --silent --show-error -X POST "{{API_URL}}/api/tasks/:id/append-summary" -H "Content-Type: text/markdown; charset=utf-8" --data-binary "@<absolute-path-to-summary.md>"
```

On Windows, run the command with `curl.exe`. No JSON wrapper or escaping is
needed inside the markdown file. With bash, a literal heredoc also works:

```bash
curl --fail-with-body --silent --show-error -X POST "{{API_URL}}/api/tasks/$id/append-summary" \
  -H "Content-Type: text/markdown" --data-binary @- <<'EOF'
## Result
What happened, in a few lines.
EOF
```

## Update many tasks at once

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
and/or mix in brand-new tasks. `format=markdown` is **never clipped** (a
clipped round-trip would destroy descriptions on the way back), so it still
honours the 256 KB ceiling: fetch **one lane at a time**, and add `since=` or
`limit=` when a lane is huge. The natural flow is:

```bash
# 1. Fetch the lane as a markdown document. `-f` matters: without it a 413
#    (lane over the ceiling) writes a JSON error blob into backlog.md, and
#    step 3 would then upsert an empty document without a word of complaint.
curl -sfG "{{API_URL}}/api/tasks" \
  --data-urlencode "project={{PROJECT_FWD}}" \
  --data-urlencode "status=backlog" \
  --data-urlencode "format=markdown" > /tmp/backlog.md || echo "fetch failed — lane too big? add since=/limit="

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

## Bulk status transition

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

## Running, merging and workflows from the API

```bash
# start an Open task (async — see the note above)
curl -s -X POST "{{API_URL}}/api/tasks/$id/run" \
  -H "Content-Type: application/json" -d '{"harness":"claude"}'

# merge one Ready-to-Merge task, or the whole lane
curl -s -X POST "{{API_URL}}/api/tasks/$id/merge"
curl -s -X POST "{{API_URL}}/api/merge-runs" \
  -H "Content-Type: application/json" -d '{"project":"{{PROJECT_FWD}}"}'
curl -s "{{API_URL}}/api/merge-runs/active?project={{PROJECT_FWD}}"
```

Workflows are the same shape — `GET /api/workflows?project=` for the ids,
`POST /api/workflows/:id/run` to start one, and
`GET /api/workflow-runs/active?project=` to watch it.

## Finding dead / unreachable code

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

## Static analysis (Opengrep)

When Opengrep is installed (Settings → Tools), a scan returns a **digest** —
markdown, worst severity first, grouped rule → file, each finding tagged with
a short fingerprint `fp` that stays stable across unrelated edits. File one
task per rule group, put `opengrep:<fp>` on its own line in the description,
and search the board for that marker before filing so a re-run never
duplicates a task. One scan runs per project at a time (a second call is a
**409** `busy`).

```bash
curl -s -X POST "{{API_URL}}/api/opengrep/scan" \
  -H "Content-Type: application/json" \
  -d '{"project":"{{PROJECT_FWD}}","includeMarkdown":true}'
# → { scan: {id, findings, bySeverity, scannedFiles, …},
#     digest: {shown, total, rules, bytes}, markdown: "# Opengrep findings …" }

# Re-read a stored scan (the id from the scan record, or the word `latest`)
# narrowed to one rule, as markdown
curl -sG "{{API_URL}}/api/opengrep/scans/$scanId" \
  --data-urlencode "project={{PROJECT_FWD}}" \
  --data-urlencode "format=md" --data-urlencode "rule=<ruleId>"
```

## Working with the board

- Group related changes into ONE task. Multiple tasks editing the same
  lines of the same file conflict during the auto-merge, which spawns a
  resolver Claude in each conflicted worktree (slow + brittle).
- Put concrete file paths and acceptance criteria in `description`.
  Each task spawns a fresh agent with no memory of the user's prior
  conversation.
- Pass the project path above (or its forward-slash form) verbatim as the
  `project` field. Lattice canonicalizes drive-letter casing.
- Read before you write: `GET /api/tasks/search?q=` is far cheaper than
  listing a lane just to check whether a task already exists.

This file is auto-managed by Lattice. It's regenerated whenever its
content changes upstream — don't edit; fork it elsewhere if you need a
customized copy.
