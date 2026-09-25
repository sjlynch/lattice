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
  other projects never receive unrelated state. `/ws/terminal-activity` (the
  sidebar tab spinner) is the one deliberate exception: it takes `?project=` to
  scope the CONNECTION like everything else, but its payload is machine-wide.
  Session ids are opaque, the sidebar already scopes its own tab list, and a
  session's `projectPath` can legitimately be a worktree rather than the project
  root — filtering on it would silently drop the task tabs the spinner exists
  for. Don't "fix" it by adding a project filter.
- `/ws/workflow-runs`' `hello` is the client's authoritative active-runs
  snapshot, but after a restart the runs are only back once post-listen
  recovery registers them. Until `isWorkflowRecoveryDone()` it therefore sends
  `{type:'hello', runs, recovering: true}` (merged additively by the client)
  and follows up per connection with an authoritative hello when recovery
  lands. `/ws/tasks` needs no such flag (tasks load from disk on demand);
  `/ws/merge-runs` / `/ws/post-merge-hooks` send `idle` until a resumed run
  re-announces itself, which only blanks a display strip — no client state
  machine reads it as "finished".
- Add a new endpoint by adding a builder here and a route tuple in
  `wsServer.ts`.
