// The spawn-scope tag a task-worktree session carries (see taskWorktreeScope.ts).
// Its own node-free module because it is part of a wire type (TerminalLaunch)
// the frontend type-checks through shared/wireTypes.ts.
export type McpSpawnScope = 'task-worktree';
