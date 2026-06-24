// Connection-health of a terminal's WebSocket/pty, surfaced as a per-tab
// indicator in the sidebar. Mirrors (but never drives) the reconnect logic in
// useTerminalConnection — the hook reports transitions, it doesn't act on this.
export type TerminalStatus =
  | 'connecting'   // initial WS handshake in flight
  | 'live'         // connected to a live pty
  | 'reconnecting' // dropped, retrying with backoff
  | 'exited'       // pty exited cleanly (see exitCode)
  | 'dead';        // gave up / session lost — needs a fresh terminal

export type TerminalSpec = {
  id: string;            // local UI id
  serverId?: string;     // backend session id, set after WS attaches
  label: string;
  cwd: string;
  initialCommand?: string;
  taskId?: string;       // associated task id, for lifecycle management
  kind?: 'merge' | 'startup'; // 'merge' → Merging tab, 'startup' → Startup tab
  startupId?: string;    // id of the StartupTerminal config that spawned this
  projectPath?: string;  // active folder this terminal belongs to — used to
                         // scope the sidebar so terminals from other projects
                         // are hidden when the user switches active folder
  status?: TerminalStatus; // connection health, reflected as a tab indicator
  exitCode?: number;     // pty exit code, recorded when status === 'exited'
};

export type Persisted = {
  terminals: TerminalSpec[];
  activeId: string | null;
};

export type Ctx = {
  terminals: TerminalSpec[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  addTerminal: (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;
  closeTerminal: (id: string) => void;
  closeTerminals: (ids: string[]) => void;
  closeTerminalsForTask: (taskId: string) => void;
  setServerId: (id: string, serverId: string) => void;
  setStatus: (id: string, status: TerminalStatus, exitCode?: number) => void;
  renameTerminal: (id: string, label: string) => void;
  reorderTerminal: (draggedId: string, targetId: string) => void;
};
