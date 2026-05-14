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
};
