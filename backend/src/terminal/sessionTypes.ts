import type * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import type { SessionBuffer } from '../terminalBuffer.js';

export type Session = {
  id: string;
  pty: pty.IPty;
  buffer: SessionBuffer;
  cols: number;
  rows: number;
  cwd: string;
  shell: string;
  // The Lattice project (active folder) this session belongs to. Used by
  // the frontend to scope terminals — when the user switches between
  // projects, only the active project's terminals are shown.
  projectPath: string;
  subscribers: Set<WebSocket>;
  createdAt: number;
  // Set the moment killSession runs the first time. Guards against
  // duplicate DELETE arrivals (StrictMode double-fire, double-click,
  // run-during-cleanup race) calling pty.kill() twice — node-pty's
  // Windows cleanup is fragile enough on the first call.
  killing: boolean;
};

export type CreateOpts = {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  initialCommand?: string;
  // Project (active folder) this terminal belongs to. Falls back to cwd
  // if not supplied — sessions created before per-project scoping was
  // wired up still have a projectPath that's at least their working dir.
  projectPath?: string;
};

export type AttachOpts = {
  id?: string | null;
  cwd?: string;
  cols?: number;
  rows?: number;
  initialCommand?: string;
  projectPath?: string;
};
