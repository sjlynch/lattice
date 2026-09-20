import type { AgentHarness } from '../../harnesses';

export type PostMergeHookStatus =
  | 'running'
  | 'completed'
  | 'aborted'
  | 'errored';

export type PostMergeHookRun = {
  id: string;
  projectPath: string;
  harness: AgentHarness;
  prompt: string;
  cwd: string;
  status: PostMergeHookStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  serverId?: string;
  terminalId?: string;
  trigger: 'merge-run' | 'manual-merge';
};

export type PostMergeHookEvent =
  | { type: 'started'; run: PostMergeHookRun }
  | { type: 'progress'; run: PostMergeHookRun }
  | { type: 'finished'; run: PostMergeHookRun }
  | { type: 'idle' };

export type PostMergeHookSnapshot = {
  active: PostMergeHookRun | null;
  recent: PostMergeHookRun | null;
};
