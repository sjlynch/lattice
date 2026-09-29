# backend/src/latticeMcp

First-party stdio MCP bridge to the task-board and Opengrep HTTP APIs.
[catalog.ts](../mcp/catalog.ts) reserves `defaultEnabled: true` for `lattice`;
never use it for third-party servers. The [MCP parent guide](../mcp/CLAUDE.md)
owns catalog policy, harness injection, scoping and opt-outs.

The harness launches the backend's Node with `dist/latticeMcp/server.js`,
which talks HTTP to the running backend. Required env: `LATTICE_API_URL`,
`LATTICE_PROJECT`; optional: `LATTICE_TASK_ID`.

## Module map

| Module | Responsibility |
|---|---|
| [createServer.ts](createServer.ts) | Server composition, registrar order and session gate. |
| [client.ts](client.ts) | HTTP outcomes, bounded retries and injectable polling sleep. |
| [toolResult.ts](toolResult.ts) | MCP result mapping, status descriptions and kept-branch hint. |
| [server.ts](server.ts) | Env validation, stderr logging and stdio transport. |
| [entryPath.ts](entryPath.ts) | Resolves compiled sibling `server.js` via `import.meta.url`. |
| [tools/readTools.ts](tools/readTools.ts) | `board_summary`, `list_tasks`, `get_task`, `my_task`, `search_tasks`. |
| [tools/writeTools.ts](tools/writeTools.ts) | `create_task`, `create_tasks`, `append_summary`. |
| [tools/boardManagementTools.ts](tools/boardManagementTools.ts) | `update_task`, `transition_tasks`, `delete_task`, `run_task`. |
| [tools/opengrepTools.ts](tools/opengrepTools.ts) | Scan/findings; separately registered ignore. |

## Registration and session scope

Model-visible order: read tools → write tools → Opengrep read tools →
Opengrep ignore → board management. `createServer.ts` returns before the last
two groups when `taskId` is set. Normal sessions have 14 tools; task-worktree
sessions have 10: add `my_task`, allow `append_summary.id` to default to the
session task, and omit board management plus `opengrep_ignore`. Otherwise
`append_summary.id` is required.

## Shared contracts

- **Project isolation:** no tool accepts `project`. The client pins `project=`
  on every request, including writes; by-id API routes refuse foreign tasks
  before acting. Successful responses assert `canonicalProject` (envelope) or
  `projectPath` (bare task) when present, using normalized paths.
- **API-owned defaults:** forward supplied arguments without duplicating API
  defaults. Discovery: `board_summary` (counts/cost) → `list_tasks` (compact,
  active lanes, newest 100 by API default) → `get_task` (full record), or
  `search_tasks` (ranked snippets, all lanes by default). Board results are
  compact JSON in one text block.
- **413 teaches narrowing:** a normal result without `isError`, carrying
  summary/suggestions. Narrow first; `confirm_large` explicitly bypasses the
  API's 256 KB ceiling.
- **Distinct failures:** `timeout` means the backend accepted the request and
  may still be working; `unreachable` means it could not be reached;
  `projectMismatch` refuses another board's response. These and `httpError`
  (status/body retained) are errors; see the scan exception below.
- **Bounded retries:** `client.ts` owns the budget. Writes replay only after
  `ECONNREFUSED` or HTTP 503 (refusal before acting); ambiguous network failures
  permit GET retries only, avoiding duplicate writes.
- **Stdout is the protocol:** `server.ts` redirects `console.log`, `info` and
  `debug` to stderr; stray stdout corrupts the JSON-RPC stream.
- **Management:** deletion erases the task/worktree, retaining an unmerged
  branch with a leading hint; update/transition moves to the `deleted` lane.
  `run_task` returns `{accepted, queued}` for admission; the agent starts later.

## Opengrep flow

`opengrep_scan` and `opengrep_findings` return digest markdown, not raw scan
JSON. Scan POSTs with `async: true`, `includeMarkdown: true`: a quick scan
returns its digest; a longer one returns 202 with a running scan id, then polls
`GET /api/opengrep/scans/<id>` with `include=markdown`. Timeout or exhausted
polling budget returns a normal "still running" result pointing to findings;
do not start another scan. Scan failures are errors; an unknown polled id
asks the agent to scan again.

`opengrep_findings` reads an existing scan (`latest` by default), narrowed by `rule`,
`file`, `severity` or `budgetKb`, and recognizes running scans.
`opengrep_ignore` adds permanent rule/fingerprint exclusions; `reason` is
echoed, never stored. The [registrar](tools/opengrepTools.ts) owns
exact timing constants and result messages; the [Opengrep guide](../opengrep/CLAUDE.md)
owns backend scan/storage details.

## Coverage

[latticeMcp.test.ts](../__tests__/latticeMcp.test.ts): registry, schemas, HTTP
forwarding, project guards, result shaping and retries via in-memory MCP and
injected fetch. [latticeMcpOpengrep.test.ts](../__tests__/latticeMcpOpengrep.test.ts):
digests, ignore writes, async polling, failures and still-running results.
