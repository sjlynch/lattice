import type * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import type { ScrollbackStore } from './scrollbackStore.js';

export type Session = {
  id: string;
  pty: pty.IPty;
  // Disk-backed scrollback (replay on attach). See scrollbackStore.ts.
  scrollback: ScrollbackStore;
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
  // When true, the spawned pty gets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` so the
  // Claude session doesn't read/write auto-memory. Resolved per-project at the
  // POST /sessions chokepoint from `UserSettings.disableClaudeMemory`.
  disableClaudeMemory?: boolean;
};

export type AttachOpts = {
  id?: string | null;
  cwd?: string;
  cols?: number;
  rows?: number;
  initialCommand?: string;
  projectPath?: string;
};
