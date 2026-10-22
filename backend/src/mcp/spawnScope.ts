// The spawn-scope tag a session carries: `task-worktree` for a task run/resume
// or worktree resolver (see taskWorktreeScope.ts); `fleet-agent` for an agent
// terminal another AGENT opened through Fleet (../fleet.ts) — any scope makes
// the spawn not user-launched, so a fleet-launched agent never gets
// `lattice-control` or the fleet tools itself (no recursive escalation).
// Its own node-free module because it is part of a wire type (TerminalLaunch)
// the frontend type-checks through shared/wireTypes.ts.
export type McpSpawnScope = 'task-worktree' | 'fleet-agent';
