export type GraphNode = {
  id: string;
  name: string;
  path: string;
  kind: 'dir' | 'file';
  ext?: string;
  size?: number;
  health?: number;
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

// ---------- Tasks ----------

export type TaskStatus =
  | 'open'
  | 'in_progress'
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

export async function deleteTask(id: string): Promise<void> {
  await asJson<{ ok: true }>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  );
}

export async function runTask(id: string): Promise<RunTaskResult> {
  return asJson<RunTaskResult>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}/run`, {
      method: 'POST',
    }),
  );
}

export function subscribeTasks(
  projectPath: string,
  onUpdate: (tasks: Task[]) => void,
): () => void {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${proto}://${window.location.host}/ws/tasks?project=${encodeURIComponent(projectPath)}`,
  );
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as { type: string; tasks?: Task[] };
      if (msg.type === 'tasks' && msg.tasks) onUpdate(msg.tasks);
    } catch {
      /* ignore */
    }
  };
  return () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}
