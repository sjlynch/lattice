# Project Claude instrumentation

This folder owns project-root Claude instrumentation used by `routes/projectClaude.ts`.

- `reconcile.ts` handles project settings side effects: hook install/removal, Claude memory opt-out, project-root MCP reconciliation, repo-local `.git/info/exclude` updates (never the tracked `.gitignore`), and the Pi subagents shim.
- `managedCwd.ts` filters Lattice-owned scratch/worktree cwd values so task/workflow/push sessions are not double-counted as generic project sessions.
- `lifecycle.ts` is the source of truth for project session presence, which follows the agent's **turns**: `UserPromptSubmit` / tool use / subagent events create the node (or bring back one the idle TTL or a restart dropped), `Stop` removes it after `TURN_END_GRACE_MS` unless activity arrives first (Claude fires early Stops around subagents), `SessionStart` alone draws nothing, and `SessionEnd` — or the tab's terminal exiting (`routes/projectClaude.ts` subscribes to the terminal registry's `ended` event, which carries the tab's pinned `agentSessionId`) — removes it for good via `endProjectSession`. Sessions carry `harness` (from the token label) so the graph colors terminal Codex white and Pi blue.
- `activity.ts` fans live project-session hook events into graph activity/focus beams after lifecycle admits the event.
- The route is harness-neutral: user-launched Codex tabs post here via per-launch `-c hooks.*` overrides (`../projectCodexHooks.ts`, token label `codex`), and a `pi` at the project root via the project-mode activity extension `reconcile.ts` writes (`../piActivity.ts`, token label `pi`).

Invariant: after `SessionEnd` (or `endProjectSession`), the session id is held in a short recently-ended guard. Any late or reordered hook for that id is dropped so a ghost node cannot reappear. A post-`Stop` removal is NOT remembered as ended — the session's next turn must bring its node back.

Invariant: `../projectClaudeHooks.ts` read-modify-writes the user's own `<project>/.claude/settings.local.json` from three writers (hook install, hook removal, auto-memory reconcile). They are serialized per file — an overlapping reconcile (second project open / settings save) used to interleave them and drop one writer's change. A file that doesn't parse, or whose `hooks` (or an event Lattice adds to) isn't the documented object/array shape, is left byte-for-byte alone.
