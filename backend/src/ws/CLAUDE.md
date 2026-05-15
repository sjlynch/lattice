# backend/src/ws

WebSocket endpoints all use `WebSocketServer({ noServer: true })` and are dispatched by the single `upgrade` listener in `wsServer.ts`. Do not add per-path `{ server, path }` WSS instances; the first listener to reject an upgrade can break the matching endpoint.

- `wsServer.ts` — public `attachWebSockets(server)` entry point and pathname route table.
- `projectEndpoint.ts` — project query parsing, JSON sends, project-scoped subscription helpers, and snapshot endpoint helper.
- `endpoints/` — endpoint-specific initial payloads/subscriptions for terminal, tasks, merge-runs, workflows, workflow-runs, health, and harness availability.
