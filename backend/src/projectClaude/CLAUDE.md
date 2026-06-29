# Project Claude instrumentation

This folder owns project-root Claude instrumentation used by `routes/projectClaude.ts`.

- `reconcile.ts` handles project settings side effects: hook install/removal, Claude memory opt-out, project-root MCP reconciliation, gitignore updates, and the Pi subagents shim.
- `managedCwd.ts` filters Lattice-owned scratch/worktree cwd values so task/workflow/push sessions are not double-counted as generic project sessions.
- `lifecycle.ts` is the source of truth for project session presence. `SessionStart` is the only event that may create a node; `SessionEnd` removes it. Tool-use and subagent events only refresh (`touchAgentSession`) and must never resurrect a missing node.
- `activity.ts` fans live project-session hook events into graph activity/focus beams after lifecycle admits the event.

Invariant: after `SessionEnd`, the session id is held in a short recently-ended guard. Any late or reordered hook for that id, including a second `SessionStart`, is dropped so duplicate/ghost nodes cannot reappear.
