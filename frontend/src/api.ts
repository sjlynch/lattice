export type GraphNode = {
  id: string;
  name: string;
  path: string;
  kind: 'dir' | 'file';
  ext?: string;
  size?: number;
  health?: number;
  loc?: number;
};

export type GraphLink = {
  source: string;
  target: string;
};

export type ScanResult = {
  root: string;
  nodes: GraphNode[];
  links: GraphLink[];
};

export type DirEntry = { name: string; path: string };
export type DirListing = {
  path: string;
  parent: string | null;
  entries: DirEntry[];
};

export async function fetchDefaultRoot(): Promise<string> {
  const r = await fetch('/api/default-root');
  const j = await r.json();
  return j.path as string;
}

export async function scanFolder(folderPath: string): Promise<ScanResult> {
  const r = await fetch(`/api/scan?path=${encodeURIComponent(folderPath)}`);
  if (!r.ok) throw new Error(`scan failed: ${r.status}`);
  return r.json();
}

export async function listDir(folderPath?: string): Promise<DirListing> {
  const url = folderPath
    ? `/api/list-dir?path=${encodeURIComponent(folderPath)}`
    : '/api/list-dir';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`list-dir failed: ${r.status}`);
  return r.json();
}

// ---------- User settings ----------

export type UserSettings = {
  sidebarWidth?: number;
  harness?: 'claude' | 'pi';
};

export async function fetchUserSettings(projectPath: string): Promise<UserSettings> {
  try {
    const r = await fetch(`/api/settings?project=${encodeURIComponent(projectPath)}`);
    if (!r.ok) return {};
    return r.json();
  } catch {
    return {};
  }
}

export async function patchUserSettings(
  projectPath: string,
  partial: Partial<UserSettings>,
): Promise<UserSettings> {
  return asJson<UserSettings>(
    await fetch(`/api/settings?project=${encodeURIComponent(projectPath)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    }),
  );
}

// ---------- Tasks ----------

export type TaskStatus =
  | 'backlog'
  | 'open'
  | 'in_progress'
  | 'ready_to_merge'
  | 'qa'
  | 'done'
  | 'deleted';

export type Task = {
  id: string;
  projectPath: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: number;
  worktreePath?: string;
  branch?: string;
  startedAt?: number;
  completedAt?: number;
  mergedAt?: number;
  conflict?: boolean;
  conflictStartedAt?: number;
  sortOrder?: number;
};

export type RunTaskResult = {
  worktreePath: string;
  branch: string;
  taskFile: string;
  command: string;
};

async function asJson<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

export async function fetchTasks(projectPath: string): Promise<Task[]> {
  return asJson<Task[]>(
    await fetch(`/api/tasks?project=${encodeURIComponent(projectPath)}`),
  );
}

export async function createTask(
  projectPath: string,
  title: string,
  description?: string,
): Promise<Task> {
  return asJson<Task>(
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath, title, description }),
    }),
  );
}

export async function updateTask(
  id: string,
  updates: Partial<Pick<Task, 'title' | 'description' | 'status'>>,
): Promise<Task> {
  return asJson<Task>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }),
  );
}

export async function reorderTasks(
  projectPath: string,
  status: TaskStatus,
  ids: string[],
): Promise<void> {
  await asJson<{ ok: true }>(
    await fetch('/api/tasks/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath, status, ids }),
    }),
  );
}

export async function deleteTask(id: string): Promise<void> {
  await asJson<{ ok: true }>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  );
}

export async function runTask(id: string, harness?: 'claude' | 'pi'): Promise<RunTaskResult> {
  return asJson<RunTaskResult>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness }),
    }),
  );
}

export async function resumeTask(id: string, harness?: 'claude' | 'pi'): Promise<RunTaskResult> {
  return asJson<RunTaskResult>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness }),
    }),
  );
}

export type MergeTaskResult =
  | { merged: true }
  | {
      merged: false;
      conflict: true;
      command: string;
      cwd: string;
      conflictedFiles?: string[];
    }
  | {
      merged: false;
      stashConflict: true;
      command: string;
      cwd: string;
      conflictedFiles?: string[];
    };

export async function mergeTask(id: string): Promise<MergeTaskResult> {
  return asJson<MergeTaskResult>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}/merge`, {
      method: 'POST',
    }),
  );
}

// ---------- Merge runs ----------

export type MergeRunStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'errored';

export type MergeRun = {
  id: string;
  projectPath: string;
  status: MergeRunStatus;
  startedAt: number;
  finishedAt?: number;
  total: number;
  processed: number;
  current?: string;
  merged: string[];
  conflicted: string[];
  errored: { taskId: string; error: string }[];
  cancelRequested: boolean;
};

export type MergeRunEvent =
  | { type: 'started'; run: MergeRun }
  | { type: 'progress'; run: MergeRun }
  | {
      type: 'conflict';
      runId: string;
      projectPath: string;
      taskId: string;
      command: string;
      cwd: string;
      conflictedFiles: string[];
    }
  | { type: 'completed'; run: MergeRun }
  | { type: 'cancelled'; run: MergeRun }
  | { type: 'idle' };

export async function startMergeRun(projectPath: string): Promise<MergeRun> {
  return asJson<MergeRun>(
    await fetch('/api/merge-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath }),
    }),
  );
}

export async function getActiveMergeRun(
  projectPath: string,
): Promise<MergeRun | null> {
  const r = await fetch(
    `/api/merge-runs/active?project=${encodeURIComponent(projectPath)}`,
  );
  if (!r.ok) return null;
  return r.json();
}

export async function cancelMergeRun(runId: string): Promise<void> {
  await asJson<{ ok: true }>(
    await fetch(`/api/merge-runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),
  );
}

export function subscribeMergeRuns(
  projectPath: string,
  onEvent: (ev: MergeRunEvent) => void,
): () => void {
  let ws: WebSocket | null = null;
  let cancelled = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (cancelled) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(
      `${proto}://${window.location.host}/ws/merge-runs?project=${encodeURIComponent(projectPath)}`,
    );
    ws.onopen = () => {
      attempt = 0;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as MergeRunEvent;
        onEvent(msg);
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => {
      /* onclose will reschedule */
    };
    ws.onclose = () => {
      if (cancelled) return;
      const delay = Math.min(5000, 250 * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
  }

  connect();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

export function subscribeTasks(
  projectPath: string,
  onUpdate: (tasks: Task[]) => void,
): () => void {
  // Auto-reconnect with exponential backoff so the subscription survives
  // a backend restart or the brief boot window when the proxy responds
  // ECONNREFUSED. The server resends the full task list on every connect,
  // so reconnecting is the same as a fresh sync.
  let ws: WebSocket | null = null;
  let cancelled = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (cancelled) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(
      `${proto}://${window.location.host}/ws/tasks?project=${encodeURIComponent(projectPath)}`,
    );
    ws.onopen = () => {
      attempt = 0;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; tasks?: Task[] };
        if (msg.type === 'tasks' && msg.tasks) onUpdate(msg.tasks);
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => {
      // onclose will fire too; reconnect is scheduled there.
    };
    ws.onclose = () => {
      if (cancelled) return;
      const delay = Math.min(5000, 250 * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
  }

  connect();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}
