# backend/src/latticeMcp

Lattice's **own** MCP server: eleven typed tools over the task-board HTTP API,
so a Lattice-spawned agent drives the board through tool calls instead of
hand-written `curl`. It is the first-party entry in the MCP catalog
(`../mcp/catalog.ts`, id `lattice`) and the one server that ships **on by
default** — see `../mcp/CLAUDE.md` for why that exception exists and how to opt
out.

## Why a server and not just the docs

Every project's generated `.lattice/LATTICE_API.md` already documents the API,
and agents did use it — badly, in three repeatable ways:

- **They forgot `project=`**, or passed a non-canonical form of it, and read a
  different board than the one they were working in.
- **They skipped the `canonicalProject` check** the docs ask them to perform by
  hand on every response.
- **They called `GET /api/tasks` unfiltered.** On this machine that is 479
  tasks / 1.28 MB / ~320k tokens for one project. It is the shape the docs show
  first, so it is the shape agents copy.

Typed tools fix all three structurally rather than by exhortation: `project` is
pinned by the client and no tool accepts one, the canonical-project assertion is
automatic, and the **tool descriptions carry the progressive-disclosure ladder**
(`board_summary` → `list_tasks` → `get_task` / `search_tasks`) to the exact place
the model reads before choosing a call — for free, on every call, with no brief
to remember.

## Process shape

The server is spawned **by the harness**, not by Lattice: the catalog entry runs
`<the backend's own node> dist/latticeMcp/server.js` with two env vars the
resolver injects per spawn.

```
harness (claude/codex/pi)
  └─ node dist/latticeMcp/server.js        LATTICE_API_URL, LATTICE_PROJECT [, LATTICE_TASK_ID]
       └─ HTTP ──▶ the running Lattice backend on :5184
```

It therefore imports **nothing** from the rest of the backend except
`../projectPath.js` (path canonicalization) — no task cache, no Express, no
node-pty. It is a short-lived stdio process that only speaks HTTP to the backend
that is already running.

## Modules

- `createServer.ts` — `createLatticeMcpServer({apiUrl, project, fetchImpl?})` →
  an `McpServer` with the eleven tools registered via `registerTool` + zod input
  schemas. Also owns `toToolResult`, the outcome → MCP-result mapping.
- `client.ts` — the HTTP layer. Builds URLs with `project` pinned, sends/parses
  JSON, asserts `canonicalProject`, and classifies each round trip into the
  five-way `LatticeCallOutcome`. Imports no MCP types, so it is testable (and
  reasonable) without a transport.
- `server.ts` — the stdio entry point. Reads `LATTICE_API_URL` +
  `LATTICE_PROJECT` (exit 1 on either missing), builds the server, connects a
  `StdioServerTransport`.
- `entryPath.ts` — `latticeMcpServerEntryPath()`, the absolute path of the
  compiled `server.js`, resolved from `import.meta.url` so it is correct from
  `dist/mcp/catalog.js` whatever that caller's depth is.

## The tools

| tier | tool | notes |
|---|---|---|
| 0 orient | `board_summary` | counts + per-lane cost. Under 1 KB. |
| 1 scan | `list_tasks` | compact / active lanes / newest 100 — **the API's defaults, not ours**; `confirm_large` is the only way past the 256 KB ceiling |
| 2 expand | `get_task` | one full record |
| 2 expand | `my_task` | **task worktree sessions only** — the live record of the task this agent is running. Registered iff `LATTICE_TASK_ID` is set (run/resume spawns); the same variable makes `append_summary`'s `id` optional |
| find | `search_tasks` | ranked, all lanes, snippets |
| write | `create_task`, `create_tasks`, `update_task`, `transition_tasks`, `append_summary`, `delete_task` | |
| run | `run_task` | returns `{accepted, queued}` — admitted, **not started** |

## Invariants

- **No tool takes a `project` argument.** It is pinned from `LATTICE_PROJECT`
  and asserted against the response envelope's `canonicalProject`. That
  assertion is the whole reason the server can be trusted with writes.
- **No tool invents a default the API already has.** `list_tasks` forwards only
  the arguments it was given, so "compact fields, active lanes, newest 100"
  lives in one place (`routes/tasks/`). Duplicating a default here would drift
  from the API silently, and the drift would only show as wrong output.
- **`stdout` is the protocol.** `server.ts` re-points `console.log`/`info`/
  `debug` at stderr before anything else runs; one stray line corrupts the
  JSON-RPC frame stream and the harness drops the server with a parse error.
- **An HTTP 413 is a normal result, never `isError`.** It is the teaching
  response (board summary + narrowing suggestions) and the agent has to read it;
  marking it an error invites a retry of the identical oversized call.
- **A connection failure and a project mismatch ARE errors**, and each says
  which it is — one means "Lattice isn't running", the other means "stop, you
  are pointed at the wrong board".
- **Results are compact JSON in one text block.** Agents parse it; indentation
  would cost tokens for nothing.

## Tests

`../__tests__/latticeMcp.test.ts` drives the real server from a real `Client`
over `InMemoryTransport.createLinkedPair()` with a recording `fetchImpl`, so it
pins the actual tool registry, zod schemas and result shaping against the exact
HTTP request each tool makes. Nothing in the suite SPAWNS the process — which is
why `entryPath.ts` resolving to a non-existent `src/latticeMcp/server.js` under
`tsx` is fine.
