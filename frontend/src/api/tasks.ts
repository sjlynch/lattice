// Task CRUD + lifecycle (run, resume, merge) + live subscription.

import { asJson, deleteJson, patchJson, postJson } from './http';
import { subscribeWs, subscribeWsShared } from './ws';
import type {
  AgentActivityEvent,
  AgentSession,
  DeleteTaskResult,
  KeptTaskBranch,
  MergeTaskResult,
  RunTaskResult,
  Task,
  TaskActivityEvent,
  TaskSpawnedEvent,
  TaskSpawnFailedEvent,
  TaskStatus,
  WorktreeModifiedTask,
} from './types';
import type { AgentHarness } from '../harnesses';

// `/api/tasks` returns an envelope ({project, canonicalProject, hash, count,
// mismatched, tasks} plus the progressive-disclosure cost/filter fields) so
// agents can detect "these aren't my tasks." The UI just unwraps `.tasks`; the
// envelope's filter is server-side defence in depth that we don't need to
// surface here.
type TasksEnvelope = {
  project: string;
  canonicalProject: string;
  hash: string;
  count: number;
  mismatched: number;
  total?: number;
  matched?: number;
  omitted?: Record<string, number>;
  truncated?: boolean;
  clipped?: number;
  fields?: 'compact' | 'full';
  bytes?: number;
  approxTokens?: number;
  hint?: string;
  missing?: string[];
  tasks: Task[];
};

// The endpoint defaults are tuned for AI agents (active lanes only, compact
// fields, newest 100, descriptions clipped) — this caller is the board itself,
// which renders every lane and needs whole records, so it opts out of all four
// and pre-confirms the size ceiling.
const WHOLE_BOARD_QUERY = 'status=all&fields=full&clip=0&limit=0&confirm_large=1';

export async function fetchTasks(projectPath: string): Promise<Task[]> {
  const env = await asJson<TasksEnvelope>(
    await fetch(
      `/api/tasks?project=${encodeURIComponent(projectPath)}&${WHOLE_BOARD_QUERY}`,
    ),
  );
  return env.tasks;
}

export async function createTask(
  projectPath: string,
  title: string,
  description?: string,
): Promise<Task> {
  return postJson<Task>('/api/tasks', { project: projectPath, title, description });
}

// Every by-id task call carries the board's project as `?project=`. The
// backend's `getTask(id)` is a GLOBAL lookup across every indexed project, so
// an id alone reaches any board on the machine; with the pin, the by-id routes
// (`requireTaskInRequestedProject`) 404 a task that belongs to a different
// board. Callers pass the ACTIVE board's project — never the task's own
// `projectPath`, which would make the check vacuous. An empty project omits the
// param, which the backend treats as unpinned (the old behaviour).
// `/merge-aborted` does not read the param today; it is harmless there and sent
// for uniformity, so the route pins the moment it starts checking.
export function taskByIdUrl(projectPath: string, id: string, suffix = ''): string {
  const base = `/api/tasks/${encodeURIComponent(id)}${suffix}`;
  return projectPath ? `${base}?project=${encodeURIComponent(projectPath)}` : base;
}

export async function updateTask(
  projectPath: string,
  id: string,
  updates: Partial<Pick<Task, 'title' | 'description' | 'status'>>,
): Promise<Task> {
  return patchJson<Task>(taskByIdUrl(projectPath, id), updates);
}

export async function reorderTasks(
  projectPath: string,
  status: TaskStatus,
  ids: string[],
): Promise<void> {
  await postJson<{ ok: true }>('/api/tasks/reorder', {
    project: projectPath,
    status,
    ids,
  });
}

// Resolves the parsed response. `keptBranch` is kept only when well-formed
// (older backends omit it; anything malformed is dropped rather than toasted).
export async function deleteTask(projectPath: string, id: string): Promise<DeleteTaskResult> {
  const body = await deleteJson<unknown>(taskByIdUrl(projectPath, id));
  return parseDeleteTaskResult(body);
}

export function parseDeleteTaskResult(body: unknown): DeleteTaskResult {
  if (!body || typeof body !== 'object') return {};
  const raw = body as { ok?: unknown; keptBranch?: unknown };
  const out: DeleteTaskResult = {};
  if (typeof raw.ok === 'boolean') out.ok = raw.ok;
  const kb = raw.keptBranch as Partial<KeptTaskBranch> | null | undefined;
  if (
    kb &&
    typeof kb === 'object' &&
    typeof kb.name === 'string' &&
    typeof kb.hint === 'string' &&
    kb.hint.trim() !== ''
  ) {
    out.keptBranch = {
      name: kb.name,
      unmergedCommits: typeof kb.unmergedCommits === 'number' ? kb.unmergedCommits : 0,
      hint: kb.hint,
    };
  }
  return out;
}

export async function runTask(
  projectPath: string,
  id: string,
  harness?: AgentHarness,
  piModel?: string,
): Promise<RunTaskResult> {
  return postJson<RunTaskResult>(taskByIdUrl(projectPath, id, '/run'), {
    harness,
    piModel,
  });
}

export async function resumeTask(
  projectPath: string,
  id: string,
  harness?: AgentHarness,
  piModel?: string,
): Promise<RunTaskResult> {
  return postJson<RunTaskResult>(taskByIdUrl(projectPath, id, '/resume'), {
    harness,
    piModel,
  });
}

// Drop a queued task run back to a plain Open task. Returns the updated task.
export async function cancelQueuedRun(projectPath: string, id: string): Promise<Task> {
  return postJson<Task>(taskByIdUrl(projectPath, id, '/cancel-queued-run'));
}

export async function mergeTask(
  projectPath: string,
  id: string,
): Promise<MergeTaskResult> {
  return postJson<MergeTaskResult>(taskByIdUrl(projectPath, id, '/merge'));
}

// Abandon an in-flight conflict resolution: aborts any lingering mid-merge in
// the worktree and clears the task's conflict flag, returning it to
// ready_to_merge. Same endpoint a resolver Claude curls when it gives up —
// here it backs the "Cancel" button on the Resolving strip, the user's escape
// hatch out of a conflict that's been orphaned (resolver died, merge run was
// cancelled, or the backend restarted mid-resolution).
export async function abortTaskMerge(projectPath: string, id: string): Promise<void> {
  await postJson<{ ok: true }>(taskByIdUrl(projectPath, id, '/merge-aborted'));
}

// `/ws/tasks` carries five message types: the full task-list snapshot; for
// queued runs a `task-spawned` event delivering the pty (or a
// `task-spawn-failed` event when the deferred spawn failed); `task-activity`
// events naming the file a Claude worktree agent is touching; and
// `agent-activity` events naming the file a Claude session OUTSIDE a worktree
// is touching. `onSpawned` lazy-mounts the terminal; `onSpawnFailed` toasts a
// failed deferred spawn; `onActivity` / `onAgentActivity` drive the graph
// focus beams.
type TasksWsMessage =
  | { type: 'tasks'; tasks: Task[] }
  | ({ type: 'task-spawned' } & TaskSpawnedEvent)
  | ({ type: 'task-spawn-failed' } & TaskSpawnFailedEvent)
  | ({ type: 'task-activity' } & TaskActivityEvent)
  | ({ type: 'agent-activity' } & AgentActivityEvent);

// Both the taskboard (`useTaskList`) and the graph (`useAgentOverlay`)
// subscribe to `/ws/tasks` for the same project. Routing through the
// ref-counted `subscribeWsShared` multiplexer means a single socket / single
// JSON.parse fans the high-frequency snapshot + activity frames out to both,
// instead of two independent sockets each parsing every frame. The `tasks`
// snapshot is cached+replayed to a late joiner (e.g. the board opening after
// the graph already opened the socket); the transient `task-spawned` /
// `*-activity` frames are NOT replayed (no stale beam re-fires).
export function subscribeTasks(
  projectPath: string,
  onUpdate: (tasks: Task[]) => void,
  onSpawned?: (event: TaskSpawnedEvent) => void,
  onActivity?: (event: TaskActivityEvent) => void,
  onAgentActivity?: (event: AgentActivityEvent) => void,
  onSpawnFailed?: (event: TaskSpawnFailedEvent) => void,
): () => void {
  return subscribeWsShared<TasksWsMessage>(
    `/ws/tasks?project=${encodeURIComponent(projectPath)}`,
    (msg) => {
      if (msg.type === 'tasks') onUpdate(msg.tasks);
      else if (msg.type === 'task-spawned') onSpawned?.(msg);
      else if (msg.type === 'task-spawn-failed') onSpawnFailed?.(msg);
      else if (msg.type === 'task-activity') onActivity?.(msg);
      else if (msg.type === 'agent-activity') onAgentActivity?.(msg);
    },
    (msg) => msg.type === 'tasks',
  );
}

// Presence of Claude sessions running OUTSIDE a task worktree (push /
// workflow step / post-merge hook). Each gets an orange node on the graph.
export function subscribeAgentSessions(
  projectPath: string,
  onUpdate: (sessions: AgentSession[]) => void,
): () => void {
  return subscribeWs<{ type: 'agent-sessions'; sessions: AgentSession[] }>(
    `/ws/agent-sessions?project=${encodeURIComponent(projectPath)}`,
    (msg) => {
      if (msg.type === 'agent-sessions') onUpdate(msg.sessions);
    },
  );
}

// Files changed by every not-yet-merged task (in_progress + ready_to_merge),
// for the `W` worktree-highlight overlay. Recomputed server-side from git on
// each call, so callers should fetch on demand (e.g. when `W` is pressed)
// rather than poll.
export async function fetchWorktreeModified(
  projectPath: string,
): Promise<WorktreeModifiedTask[]> {
  const env = await asJson<{ tasks: WorktreeModifiedTask[] }>(
    await fetch(
      `/api/tasks/worktree-modified?project=${encodeURIComponent(projectPath)}`,
    ),
  );
  return env.tasks;
}
