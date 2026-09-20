# backend/src/ws

WebSocket endpoints all use `WebSocketServer({ noServer: true })` and are dispatched by the single `upgrade` listener in `wsServer.ts`. Do not add per-path `{ server, path }` WSS instances; the first listener to reject an upgrade can break the matching endpoint.

- `wsServer.ts` — public `attachWebSockets(server)` entry point and pathname route table.
- `projectEndpoint.ts` — project query parsing, JSON sends, project-scoped subscription helpers, and snapshot endpoint helper. `buildProjectWss` serializes each broadcast **once per event, not once per client**: a broadcast hands the *same* event object to every connection's listener (e.g. the health watcher's `proj.subscribers` fan-out), so the payload is `JSON.stringify`'d once and the string reused across all open sockets (memoized in a per-WSS `WeakMap` keyed by event identity; GC'd with the event). Byte-identical on the wire — same messages, order, and timing; the win scales with concurrent clients on one project. `sendJson` stays for single-recipient sends (initial payloads).
- `endpoints/` — endpoint-specific initial payloads/subscriptions for terminal,
  terminal-tabs (the durable tab registry: `hello` snapshot + live
  upsert/ended/removed/restored events, see `terminalRegistry/`),
  tasks, agent-sessions, merge-runs, post-merge-hooks, workflows,
  workflow-runs, health, git-branch (navbar branch chip, `.git/HEAD` watcher),
  git-status (timeline-scrubber live refresh, `.git`-metadata + working-tree
  watcher), and harness availability.
