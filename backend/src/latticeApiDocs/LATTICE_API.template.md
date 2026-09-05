# Lattice API

Lattice is a local task/worktree orchestrator on this machine. Drive its HTTP
API directly when the user mentions tasks, merging or worktrees.

## Values for THIS session (use them literally)

- **API base:** `{{API_URL}}` — **hash:** `{{PROJECT_HASH}}`
- **Project:** `{{PROJECT}}` — forward-slash form, for URLs + JSON:
  `{{PROJECT_FWD}}`

Baked into every recipe below. Nothing depends on shell expansion — the
Windows pty shell is `cmd.exe`, where `$VAR` is literal.

## What Lattice is (concepts the user may ask about)

- **Task board** — lanes `Backlog → Open → In Progress → Ready to Merge → QA →
  Done`. Running an Open task cuts a git worktree, writes `LATTICE_TASK.md` and
  spawns an agent; it commits → Ready to Merge. Merging pulls main into that
  branch first, then fast-forwards main; conflicts get a resolver agent.
- **Worktrees** — one per running task, outside the repo under
  `~/.lattice/worktrees/`; the in-project `.lattice/` is managed state only.
- **Workflows** — saved step chains; agent steps file tasks (never implement),
  control steps (`start`/`merge`/`push`) drive the board.
- **Terminals** — sidebar tabs, one per agent session (`claude`/`codex`/`pi`);
  **Startup terminals** auto-run project commands on open.

## Hard rules

1. Never write scripts into `.lattice/` — managed state; use the OS temp dir.
2. `project=` is the path above, never the cwd. Every envelope returns
   `canonicalProject` + `hash`; if they don't match, stop and tell the user.
3. Never trust `.lattice/**/tasks*.json` — stale scratch. The API is the only
   source of truth; don't grep for tasks.

## Reading the board — cheapest first

| tier | call | typical cost |
|---|---|---|
| orient | `GET /api/tasks/summary` | <1 KB / ~200 tok |
| scan | `GET /api/tasks` (compact, active, newest 100) | ~2 KB / 500 tok |
| expand | `GET /api/tasks/$id` or list `ids=` | ~1.5 KB / 375 tok |
| find | `GET /api/tasks/search` + `q=` | ~1 KB / 250 tok |

Defaults are narrow because a board can reach a **megabyte**: active lanes only
(`done`/`deleted` counted in `omitted`), `fields=compact`, newest `limit=100`,
text clipped at 500 chars; over **256 KB** it 413s with a summary +
`suggestions` (`confirm_large=1` forces it). Every envelope carries `bytes`,
`approxTokens` and often a `hint` — **read the hint**: it names the knob to
widen (`status=all`, `limit=`, `since=30d`, `clip=0`, `fields=full`).

## Core recipes

Each GET is `curl -s "<url>"` in bash, `irm "<url>"` in PowerShell:

```
{{API_URL}}/api/tasks/summary?project={{PROJECT_FWD}}
{{API_URL}}/api/tasks?project={{PROJECT_FWD}}
{{API_URL}}/api/tasks/search?project={{PROJECT_FWD}}&q=graph+legend
{{API_URL}}/api/tasks/$id
```

**Create one task** — form-encoded; no JSON, no escaping:
```bash
curl -s -X POST "{{API_URL}}/api/tasks?project={{PROJECT_FWD}}" \
  --data-urlencode "title=<title>" --data-urlencode "description=<details>"
```
```pwsh
irm -Method Post "{{API_URL}}/api/tasks?project={{PROJECT_FWD}}" -Body @{ title='<title>'; description='<details>' }
```

If this session has the `lattice` MCP tools — `board_summary`, `list_tasks`,
`search_tasks`, `get_task`, `create_task(s)`, `update_task`, `transition_tasks`,
`append_summary`, `delete_task`, `run_task` — prefer them over curl: they pin
the project and price every result.

Everything else — endpoint table, batch/markdown round-trip, bulk update,
transitions, run/merge, dead code — is in `{{RECIPES_PATH}}`.

Auto-managed by Lattice — regenerated upstream; don't edit it.
