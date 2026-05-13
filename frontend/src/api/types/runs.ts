export type MergeRunStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'errored';

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
  errored: { taskId: string; error: string }[];
  cancelRequested: boolean;
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
    }
  | { type: 'completed'; run: MergeRun }
  | { type: 'cancelled'; run: MergeRun }
  | { type: 'idle' };

export type StartPushRunResult = {
  id: string;
  command: string;
  cwd: string;
  serverId?: string;
};

export type PushRunStatus = 'running' | 'done';
