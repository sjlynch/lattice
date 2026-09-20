import type { AgentHarness } from '../harnesses.js';

export type PostMergeHookStatus = 'running' | 'completed' | 'aborted' | 'errored';

// One in-flight (or recently finished) hook run. We keep the latest run per
// project around briefly after completion so the UI can render a result chip
// before the user clears it.
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
  // Durable terminal-registry tab id for the hook's pty (terminalRegistry/).
  terminalId?: string;
  // What triggered this hook — surfaced for telemetry / debugging.
  trigger: 'merge-run' | 'manual-merge';
};

export type PostMergeHookSession = {
  id: string;
  cwd: string;
  instructionsFile: string;
  harness: AgentHarness;
};
