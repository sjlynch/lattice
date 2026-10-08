// `Task` / `TaskStatus` are the backend's own (backend/src/taskCache/types.ts,
// re-exported through backend/src/shared/wireTypes.ts); the request/response
// and WS event shapes below are declared here.
import type { AgentHarness } from '../../harnesses';

export type { Task, TaskStatus } from '../../../../backend/src/shared/wireTypes';

export type RunTaskResult = {
  accepted: boolean;
  // true ⇒ deferred (no concurrency headroom); false ⇒ spawning now.
  queued: boolean;
};

// `DELETE /api/tasks/:id`. `keptBranch` is present only when the task's
// `lattice/*` branch still had unmerged commits and was kept rather than
// deleted; `hint` is the user-facing recovery text (shown as a toast).
export type KeptTaskBranch = {
  name: string;
  unmergedCommits: number;
  hint: string;
};

export type DeleteTaskResult = {
  ok?: boolean;
  keptBranch?: KeptTaskBranch;
};

// Pushed on `/ws/tasks` when a queued task's pty spawns. The frontend
// lazy-mounts the task's terminal from it (mirrors workflow `step-spawned`).
export type TaskSpawnedEvent = {
  taskId: string;
  title: string;
  command: string;
  worktreePath: string;
  serverId: string;
  projectPath: string;
  // Durable registry tab id (see api/types/terminalTabs.ts); used as the
  // sidebar tab's own id so a restore rebuilds the same tab.
  terminalId?: string;
};

// Pushed on `/ws/tasks` when a queued run/resume fails for a non-CAP reason
// (worktree setup threw, terminal-server wedged, worktree vanished). The
// outcome can't ride the HTTP response (the spawn runs later in the queue),
// so this is how the UI learns the run never started — it toasts the reason.
export type TaskSpawnFailedEvent = {
  taskId: string;
  title: string;
  // Which queued spawn failed, so the toast can say "start" vs "resume".
  kind: 'run' | 'resume';
  reason: string;
  projectPath: string;
};

// Pushed on `/ws/tasks` while a Claude worktree agent reads/modifies a file.
// The graph draws a focus beam from the task's Claude node to that file.
export type TaskActivityEvent = {
  taskId: string;
  projectPath: string;
  // Project-absolute path of the touched file (matches a graph node `path`).
  // Absent on `lifecycle` (SubagentStart/Stop) events.
  file?: string;
  // 'start' = PreToolUse, 'end' = PostToolUse.
  phase: 'start' | 'end';
  tool: string;
  ts: number;
  // Subagent attribution. When set, this event pertains to a *satellite* (a
  // Task/Agent subagent) of the task's Claude node, not the main agent.
  subagentId?: string;
  subagentType?: string;
  // SubagentStart ('spawn') / SubagentStop ('stop') — a satellite appears /
  // disappears. `file` is absent on these.
  lifecycle?: 'spawn' | 'stop';
};

// One task's not-yet-merged file set, from `GET /api/tasks/worktree-modified`.
// Drives the `W` worktree-highlight overlay.
export type WorktreeModifiedTask = {
  taskId: string;
  colorIndex?: number;
  // Project-absolute paths.
  files: string[];
};

// Pushed on `/ws/tasks` while a Claude session OUTSIDE a worktree (push /
// workflow step / post-merge hook) touches a file. Drives the focus beam on
// that session's orange node.
export type AgentActivityEvent = {
  agentId: string;
  projectPath: string;
  label: string;
  // Absent on `lifecycle` (SubagentStart/Stop) events.
  file?: string;
  phase: 'start' | 'end';
  tool: string;
  ts: number;
  // Subagent attribution — see TaskActivityEvent.
  subagentId?: string;
  subagentType?: string;
  lifecycle?: 'spawn' | 'stop';
};

// Presence snapshot entry from `/ws/agent-sessions`. One orange Claude node
// is shown per active non-worktree session.
export type AgentSession = {
  agentId: string;
  projectPath: string;
  label: string;
  startedAt: number;
  // The session's harness, for its graph color. Set for an agent in a terminal
  // the user opened and for a workflow step; push / QA / post-merge hook
  // sessions omit it.
  harness?: AgentHarness;
};

export type MergeTaskResult =
  | { merged: true }
  | {
      merged: false;
      conflict: true;
      command: string;
      cwd: string;
      conflictedFiles?: string[];
      serverId?: string;
      terminalId?: string;
      // Set when the backend could not pre-spawn the resolver pty (no
      // `serverId`). The UI toasts it instead of opening a terminal itself.
      resolverError?: string;
      // The resolver already running in the worktree was handed back instead
      // of a fresh spawn (the conflict pill / Merge re-clicked mid-resolve).
      existingResolver?: true;
    }
  | {
      merged: false;
      stashConflict: true;
      command: string;
      cwd: string;
      conflictedFiles?: string[];
      serverId?: string;
      terminalId?: string;
      // Set when the backend could not pre-spawn the resolver pty (no
      // `serverId`). The UI toasts it instead of opening a terminal itself.
      resolverError?: string;
    };
