// Wire types of the Fleet surface — GET /api/fleet, the terminal screen /
// input / wait routes and POST /api/fleet/agents (node-free: re-exported
// through ../shared/wireTypes.ts to the frontend).

import type { AgentHarness } from '../shared/harnesses.js';

export type FleetTerminal = {
  // The pty id (what /api/terminals/:id/* take).
  id: string;
  // The durable tab id when the registry knows this pty.
  tabId?: string;
  label: string;
  owner?: string;
  harness?: AgentHarness;
  taskId?: string;
  busy: boolean;
  createdAt: number;
  lastOutputAt?: number;
};

export type FleetAgent = {
  agentId: string;
  label: string;
  harness?: AgentHarness;
  startedAt: number;
};

export type FleetRun = {
  id: string;
  kind: 'workflow' | 'merge';
  label: string;
  status: string;
  startedAt?: number;
};

export type FleetTask = {
  id: string;
  title: string;
  status: string;
  harness?: AgentHarness;
  model?: string;
};

export type FleetProject = {
  path: string;
  name: string;
  // Task counts per lane (all lanes present, zeros included).
  lanes: Record<string, number>;
  // In-progress tasks (the agents working right now), newest first, ≤ 12.
  inProgress: FleetTask[];
  runs: FleetRun[];
  agents: FleetAgent[];
  terminals: FleetTerminal[];
  // Newest of task activity, terminal output and runs (epoch ms).
  lastActivityAt: number;
};

export type FleetEventKind =
  | 'task'
  | 'task-run'
  | 'workflow'
  | 'merge'
  | 'agent'
  | 'terminal';

export type FleetEvent = {
  seq: number;
  at: number;
  projectPath: string;
  kind: FleetEventKind;
  text: string;
  // The task / run / terminal the event is about, when there is one.
  ref?: string;
};

export type FleetSnapshot = {
  generatedAt: number;
  projects: FleetProject[];
  // Events after the request's `since` (oldest first, ≤ 200), and the newest
  // seq to pass as `since` next time.
  events: FleetEvent[];
  seq: number;
  // Whether agents may open / read / drive terminals (global setting).
  agentControl: boolean;
};

export type TerminalScreen = {
  id: string;
  cols: number;
  rows: number;
  // The visible screen, trailing blanks trimmed.
  screen: string;
  // The last `lines` lines of scrollback + screen, as rendered text.
  tail: string;
};

export type FleetLaunchResult = {
  // Pty id (for the terminal routes) and durable tab id.
  id: string;
  terminalId?: string;
  label: string;
  promptFile: string;
};
