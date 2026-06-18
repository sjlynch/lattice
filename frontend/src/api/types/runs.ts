export type MergeRunStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'errored';

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

// A QA e2e run: a Playwright-enabled Claude session that exercises one merged
// QA-lane task end-to-end. Spawned per task from the QA lane when the
// Playwright MCP toggle is on.
export type StartQaRunResult = {
  id: string;
  taskId: string;
  command: string;
  cwd: string;
  serverId?: string;
};

export type QaRunStatus = 'running' | 'done';
