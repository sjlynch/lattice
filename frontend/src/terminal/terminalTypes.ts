import type { RestoreSummary } from '../api/types/terminalTabs';

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
  // True when `id` is the backend's durable registry id (terminalRegistry/):
  // the tab survives a reload / restart and closes via /api/terminal-tabs.
  // A serverless fallback tab (pre-create failed) stays unregistered.
  registered?: boolean;
  // Restore state. 'pending' — the registry knows the tab but its pty is
  // being relaunched (no pane may mount: a serverless attach would run the
  // launch command a second time). 'failed' — the relaunch failed; the tab
  // shows the reason and waits to be closed.
  restore?: 'pending' | 'failed';
  restoreReason?: string;
  // Set on a tab that restore re-attached or relaunched, until the user
  // first activates it (a small "restored" marker on the tab).
  restored?: boolean;
  // Bumped when restore puts a DIFFERENT pty behind the tab (a relaunch, or
  // an adoption of an orphan pty). The Sidebar keys the pane on it so a
  // mounted pane that already gave up on the dead pty (`session_lost` →
  // terminated) is remounted against the new one. Deliberately NOT bumped
  // when a serverless pane merely captures its own id — that must never
  // recreate the Terminal (see components/terminal/CLAUDE.md).
  relaunchNonce?: number;
};

export type Persisted = {
  terminals: TerminalSpec[];
  activeId: string | null;
};

// `id` may be supplied by the caller when the backend minted the durable
// registry id for this tab (every Lattice spawn site returns a `terminalId`).
export type AddTerminalSpec = Omit<TerminalSpec, 'id'> & { id?: string };

export type Ctx = {
  terminals: TerminalSpec[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  addTerminal: (spec: AddTerminalSpec, focus?: boolean) => string;
  closeTerminal: (id: string) => void;
  closeTerminals: (ids: string[]) => void;
  closeTerminalsForTask: (taskId: string) => void;
  setServerId: (id: string, serverId: string) => void;
  setStatus: (id: string, status: TerminalStatus, exitCode?: number) => void;
  renameTerminal: (id: string, label: string) => void;
  reorderTerminal: (draggedId: string, targetId: string) => void;
  // Run (or re-run) the registry restore for the active project. Resolves
  // with the backend's summary (adopted / queued / dropped). `retry` also
  // retries tabs that ended as cwd-missing / restore-failed (the button does).
  restoreTabs: (opts?: { retry?: boolean }) => Promise<RestoreSummary | null>;
  // The last restore summary for the active project, for the sidebar notice.
  lastRestore: RestoreNotice | null;
  dismissRestoreNotice: () => void;
  // 'ask' mode: the registry has restorable tabs and is waiting for the user.
  restorePrompt: { count: number } | null;
};

export type RestoreNotice = {
  projectPath: string;
  summary: RestoreSummary;
  at: number;
};
