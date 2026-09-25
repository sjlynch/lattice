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
  // A Claude Stop-hook completion the quiescence gate (stopHookGate.ts) is
  // still holding — the time of the most recent such Stop. Persisted for the
  // same reason as WorkflowRun.stopReceived: the gate is an in-memory timer, the
  // hook got its 200 and won't retry, and the agent is idle, so a restart
  // inside the settle window used to lose the completion (the hook then sat
  // "running" until its bounded wait expired and errored it). A re-adopting
  // backend re-arms the gate from here (recovery/oneOffRunResume.ts).
  stopReceivedAt?: number;
  // The last time that holding gate saw the session busy (throttled) — a
  // restart re-arms the quiet window from the later of the two.
  stopActiveAt?: number;
};

export type PostMergeHookSession = {
  id: string;
  cwd: string;
  instructionsFile: string;
  harness: AgentHarness;
};
