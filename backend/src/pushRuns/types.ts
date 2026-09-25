export type PushRun = {
  id: string;
  projectPath: string;
  cwd: string;
  status: 'running' | 'done';
  createdAt: number;
  doneAt?: number;
  // The pty running the session (terminal-server id). Persisted so boot
  // recovery can re-attach a session that survived a backend restart.
  serverId?: string;
  // Set when the session was spawned by a workflow's Push control step. A
  // re-dispatched Push step (after a backend restart) attaches to this still-
  // live session instead of spawning a second push alongside it.
  workflowRunId?: string;
  workflowStepIndex?: number;
  // Set when the run was settled because its terminal died without calling
  // `/done` (seen by boot recovery / its liveness watch). Nothing confirmed the
  // push landed, so a waiting workflow Push step fails rather than reporting
  // `push complete`.
  lost?: boolean;
};

export type PushSession = {
  id: string;
  cwd: string;
  instructionsFile: string;
};
