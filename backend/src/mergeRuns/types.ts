export type MergeRunStatus = 'running' | 'completed' | 'cancelled' | 'errored';

export type MergeRunErrorEntry = { taskId: string; error: string };

export type MergeRun = {
  id: string;
  projectPath: string;
  status: MergeRunStatus;
  startedAt: number;
  finishedAt?: number;
  total: number;
  processed: number;
  current?: string;
  merged: string[];
  conflicted: string[];
  errored: MergeRunErrorEntry[];
  cancelRequested: boolean;
  resolvers?: Record<string, { sessionId: string; lastProgressAt: number }>;
};

export type MergeRunEvent =
  | { type: 'started'; run: MergeRun }
  | { type: 'progress'; run: MergeRun }
  | {
      type: 'conflict';
      runId: string;
      projectPath: string;
      taskId: string;
      command: string;
      cwd: string;
      conflictedFiles: string[];
      serverId?: string;
      // Durable registry tab id for the resolver's pty (terminalRegistry/).
      terminalId?: string;
    }
  | { type: 'completed'; run: MergeRun }
  | { type: 'cancelled'; run: MergeRun };

export type ConflictWaiterEntry = { runId: string; resolve: () => void };
