# backend/src/ws/endpoints

Endpoint-specific WebSocket builders. `../wsServer.ts` is the only place that
attaches them to HTTP upgrades.

- Most endpoints are project-scoped and should use `buildProjectWss` or
  `buildProjectSnapshotWss` from `../projectEndpoint.ts`; they require a
  `?project=` query and close on missing/invalid projects.
- `/ws/terminal` is the exception: it proxies terminal-server sessions and uses
  its own query (`id`, `cwd`, `cols`, `rows`, `initialCommand`). Do not force it
  through project helpers.
- Initial snapshots should be small and safe to send once per connection;
  broadcast payloads are serialized once per event by the shared helper.
- Keep event filtering by canonical project path on the server side so tabs for
  other projects never receive unrelated state.
- Add a new endpoint by adding a builder here and a route tuple in
  `wsServer.ts`.
