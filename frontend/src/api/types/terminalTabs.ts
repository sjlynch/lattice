import type { AgentHarness } from '../../harnesses';

// Mirrors backend/src/terminalRegistry/types.ts — the durable terminal-tab
// registry that lets the sidebar rebuild (and relaunch) its tabs after a
// backend restart, a closed browser, a Ctrl+C of the dev server, or a reboot.

export type TerminalOwner =
  | 'user'
  | 'task'
  | 'merge'
  | 'startup'
  | 'workflow-step'
  | 'push'
  | 'qa'
  | 'post-merge'
  | 'prompt-customization';

export type TerminalEndReason =
  | 'exit'
  | 'closed'
  | 'killed'
  | 'owner-finished'
  | 'cwd-missing'
  | 'restore-failed';

export type TerminalEnded = {
  at: number;
  reason: TerminalEndReason;
  exitCode?: number;
  detail?: string;
};

export type AgentSessionRef = {
  harness: AgentHarness;
  id: string;
  source: 'minted' | 'rollout-scan';
  ambiguous?: boolean;
};

export type TerminalRecord = {
  id: string;
  projectPath: string;
  cwd: string;
  label: string;
  order: number;
  kind?: 'merge' | 'startup';
  taskId?: string;
  startupId?: string;
  owner: TerminalOwner;
  launch: {
    initialCommand?: string;
    harness?: AgentHarness;
    piModel?: string;
    isQaRun?: boolean;
    taskId?: string;
    mcpScope?: 'task-worktree';
  };
  agentSession?: AgentSessionRef;
  serverId?: string;
  serverInstanceId?: string;
  createdAt: number;
  updatedAt: number;
  restoreCount?: number;
  restoredAt?: number;
  // A restore pass (possibly another browser tab's) has this tab's relaunch
  // queued or in flight.
  relaunching?: boolean;
  ended?: TerminalEnded;
};

export type RestoreDropped = { id: string; label: string; reason: string };

export type RestoreSummary = {
  status: 'ok' | 'terminal-server-unreachable' | 'already-running';
  adopted: number;
  queued: number;
  dropped: RestoreDropped[];
  // Tab ids queued for a relaunch (marked "restored" from this response).
  relaunchedIds?: string[];
};

export type TerminalTabsEvent =
  | { type: 'hello'; tabs: TerminalRecord[] }
  | { type: 'upsert'; projectPath: string; record: TerminalRecord }
  | { type: 'ended'; projectPath: string; id: string; ended: TerminalEnded }
  | { type: 'removed'; projectPath: string; id: string }
  | { type: 'restored'; projectPath: string; record: TerminalRecord; mode: 'adopted' | 'relaunched' }
  | { type: 'restore-failed'; projectPath: string; id: string; reason: string }
  | { type: 'restore-summary'; projectPath: string; summary: RestoreSummary };

export type RestoreTerminalsMode = 'always' | 'ask' | 'never';
